import EventEmitter from 'safe-event-emitter';
import { ObservableStore } from '@metamask/obs-store';
import { bufferToHex, keccak, toBuffer, isHexString } from 'ethereumjs-util';
import EthQuery from 'ethjs-query';
import { ethErrors } from 'eth-rpc-errors';
import abi from 'human-standard-token-abi';
import Common from '@ethereumjs/common';
import { TransactionFactory } from '@ethereumjs/tx';
import { ethers } from 'ethers';
import NonceTracker from 'nonce-tracker';
import log from 'loglevel';
import BigNumber from 'bignumber.js';
import cleanErrorStack from '../../lib/cleanErrorStack';
import {
  hexToBn,
  bnToHex,
  BnMultiplyByFraction,
  addHexPrefix,
  getChainType,
} from '../../lib/util';
import { TRANSACTION_NO_CONTRACT_ERROR_KEY } from '../../../../ui/helpers/constants/error-keys';
import { getSwapsTokensReceivedFromTxMeta } from '../../../../ui/pages/swaps/swaps.util';
import { hexWEIToDecGWEI } from '../../../../ui/helpers/utils/conversions.util';
import {
  TRANSACTION_STATUSES,
  TRANSACTION_TYPES,
  TRANSACTION_ENVELOPE_TYPES,
  TRANSACTION_EVENTS,
} from '../../../../shared/constants/transaction';
import { TRANSACTION_ENVELOPE_TYPE_NAMES } from '../../../../ui/helpers/constants/transactions';
import { METAMASK_CONTROLLER_EVENTS } from '../../metamask-controller';
import {
  GAS_LIMITS,
  GAS_ESTIMATE_TYPES,
  GAS_RECOMMENDATIONS,
  CUSTOM_GAS_ESTIMATE,
  PRIORITY_LEVELS,
} from '../../../../shared/constants/gas';
import { decGWEIToHexWEI } from '../../../../shared/modules/conversion.utils';
import {
  HARDFORKS,
  MAINNET,
  NETWORK_TYPE_RPC,
  CHAIN_ID_TO_GAS_LIMIT_BUFFER_MAP,
} from '../../../../shared/constants/network';
import { isEIP1559Transaction } from '../../../../shared/modules/transaction.utils';
import { readAddressAsContract } from '../../../../shared/modules/contract-utils';
import { isEqualCaseInsensitive } from '../../../../ui/helpers/utils/util';
import TransactionStateManager from './tx-state-manager';
import TxGasUtil from './tx-gas-utils';
import PendingTransactionTracker from './pending-tx-tracker';
import * as txUtils from './lib/util';

const hstInterface = new ethers.utils.Interface(abi);

const MAX_MEMSTORE_TX_LIST_SIZE = 100; // Number of transactions (by unique nonces) to keep in memory

const SWAP_TRANSACTION_TYPES = [
  TRANSACTION_TYPES.SWAP,
  TRANSACTION_TYPES.SWAP_APPROVAL,
];

/**
 * @typedef {import('../../../../shared/constants/transaction').TransactionMeta} TransactionMeta
 * @typedef {import('../../../../shared/constants/transaction').TransactionMetaMetricsEventString} TransactionMetaMetricsEventString
 */

/**
 * @typedef {Object} CustomGasSettings
 * @property {string} [gas] - The gas limit to use for the transaction
 * @property {string} [gasPrice] - The gasPrice to use for a legacy transaction
 * @property {string} [maxFeePerGas] - The maximum amount to pay per gas on a
 *  EIP-1559 transaction
 * @property {string} [maxPriorityFeePerGas] - The maximum amount of paid fee
 *  to be distributed to miner in an EIP-1559 transaction
 */

/**
 * Transaction Controller is an aggregate of sub-controllers and trackers
 * composing them in a way to be exposed to the metamask controller
 *
 * - `txStateManager
 * responsible for the state of a transaction and
 * storing the transaction
 * - pendingTxTracker
 * watching blocks for transactions to be include
 * and emitting confirmed events
 * - txGasUtil
 * gas calculations and safety buffering
 * - nonceTracker
 * calculating nonces
 *
 * @param {Object} opts
 * @param {Object} opts.initState - initial transaction list default is an empty array
 * @param {Object} opts.networkStore - an observable store for network number
 * @param {Object} opts.blockTracker - An instance of eth-blocktracker
 * @param {Object} opts.provider - A network provider.
 * @param {Function} opts.signTransaction - function the signs an @ethereumjs/tx
 * @param {Object} opts.getPermittedAccounts - get accounts that an origin has permissions for
 * @param {Function} opts.signTransaction - ethTx signer that returns a rawTx
 * @param {number} [opts.txHistoryLimit] - number *optional* for limiting how many transactions are in state
 * @param {Object} opts.preferencesStore
 */

export default class TransactionController extends EventEmitter {
  constructor(opts) {
    super();
    this.networkStore = opts.networkStore || new ObservableStore({});
    this._getCurrentChainId = opts.getCurrentChainId;
    this.getProviderConfig = opts.getProviderConfig;
    this._getCurrentNetworkEIP1559Compatibility =
      opts.getCurrentNetworkEIP1559Compatibility;
    this._getCurrentAccountEIP1559Compatibility =
      opts.getCurrentAccountEIP1559Compatibility;
    this.preferencesStore = opts.preferencesStore || new ObservableStore({});
    this.provider = opts.provider;
    this.getPermittedAccounts = opts.getPermittedAccounts;
    this.blockTracker = opts.blockTracker;
    this.signEthTx = opts.signTransaction;
    this.inProcessOfSigning = new Set();
    this._trackMetaMetricsEvent = opts.trackMetaMetricsEvent;
    this._getParticipateInMetrics = opts.getParticipateInMetrics;
    this._getEIP1559GasFeeEstimates = opts.getEIP1559GasFeeEstimates;
    this.createEventFragment = opts.createEventFragment;
    this.updateEventFragment = opts.updateEventFragment;
    this.finalizeEventFragment = opts.finalizeEventFragment;
    this.getEventFragmentById = opts.getEventFragmentById;

    this.memStore = new ObservableStore({});
    this.query = new EthQuery(this.provider);

    this.txGasUtil = new TxGasUtil(this.provider);
    this._mapMethods();
    this.txStateManager = new TransactionStateManager({
      initState: opts.initState,
      txHistoryLimit: opts.txHistoryLimit,
      getNetwork: this.getNetwork.bind(this),
      getCurrentChainId: opts.getCurrentChainId,
    });
    this._onBootCleanUp();

    this.store = this.txStateManager.store;
    this.nonceTracker = new NonceTracker({
      provider: this.provider,
      blockTracker: this.blockTracker,
      getPendingTransactions: this.txStateManager.getPendingTransactions.bind(
        this.txStateManager,
      ),
      getConfirmedTransactions: this.txStateManager.getConfirmedTransactions.bind(
        this.txStateManager,
      ),
    });

    this.pendingTxTracker = new PendingTransactionTracker({
      provider: this.provider,
      nonceTracker: this.nonceTracker,
      publishTransaction: (rawTx) => this.query.sendRawTransaction(rawTx),
      getPendingTransactions: () => {
        const pending = this.txStateManager.getPendingTransactions();
        const approved = this.txStateManager.getApprovedTransactions();
        return [...pending, ...approved];
      },
      approveTransaction: this.approveTransaction.bind(this),
      getCompletedTransactions: this.txStateManager.getConfirmedTransactions.bind(
        this.txStateManager,
      ),
    });

    this.txStateManager.store.subscribe(() =>
      this.emit(METAMASK_CONTROLLER_EVENTS.UPDATE_BADGE),
    );
    this._setupListeners();
    // memstore is computed from a few different stores
    this._updateMemstore();
    this.txStateManager.store.subscribe(() => this._updateMemstore());
    this.networkStore.subscribe(() => {
      this._onBootCleanUp();
      this._updateMemstore();
    });

    // request state update to finalize initialization
    this._updatePendingTxsAfterFirstBlock();
  }

  /**
   * Gets the current chainId in the network store as a number, returning 0 if
   * the chainId parses to NaN.
   *
   * @returns {number} The numerical chainId.
   */
  getChainId() {
    const networkState = this.networkStore.getState();
    const chainId = this._getCurrentChainId();
    const integerChainId = parseInt(chainId, 16);
    if (networkState === 'loading' || Number.isNaN(integerChainId)) {
      return 0;
    }
    return integerChainId;
  }

  async getEIP1559Compatibility(fromAddress) {
    const currentNetworkIsCompatible = await this._getCurrentNetworkEIP1559Compatibility();
    const fromAccountIsCompatible = await this._getCurrentAccountEIP1559Compatibility(
      fromAddress,
    );
    return currentNetworkIsCompatible && fromAccountIsCompatible;
  }

  /**
   * `@ethereumjs/tx` uses `@ethereumjs/common` as a configuration tool for
   * specifying which chain, network, hardfork and EIPs to support for
   * a transaction. By referencing this configuration, and analyzing the fields
   * specified in txParams, `@ethereumjs/tx` is able to determine which EIP-2718
   * transaction type to use.
   *
   * @param fromAddress
   * @returns {Common} common configuration object
   */
  async getCommonConfiguration(fromAddress) {
    const { type, nickname: name } = this.getProviderConfig();
    const supportsEIP1559 = await this.getEIP1559Compatibility(fromAddress);

    // This logic below will have to be updated each time a hardfork happens
    // that carries with it a new Transaction type. It is inconsequential for
    // hardforks that do not include new types.
    const hardfork = supportsEIP1559 ? HARDFORKS.LONDON : HARDFORKS.BERLIN;

    // type will be one of our default network names or 'rpc'. the default
    // network names are sufficient configuration, simply pass the name as the
    // chain argument in the constructor.
    if (type !== NETWORK_TYPE_RPC) {
      return new Common({
        chain: type,
        hardfork,
      });
    }

    // For 'rpc' we need to use the same basic configuration as mainnet,
    // since we only support EVM compatible chains, and then override the
    // name, chainId and networkId properties. This is done using the
    // `forCustomChain` static method on the Common class.
    const chainId = parseInt(this._getCurrentChainId(), 16);
    const networkId = this.networkStore.getState();

    const customChainParams = {
      name,
      chainId,
      // It is improbable for a transaction to be signed while the network
      // is loading for two reasons.
      // 1. Pending, unconfirmed transactions are wiped on network change
      // 2. The UI is unusable (loading indicator) when network is loading.
      // setting the networkId to 0 is for type safety and to explicity lead
      // the transaction to failing if a user is able to get to this branch
      // on a custom network that requires valid network id. I have not ran
      // into this limitation on any network I have attempted, even when
      // hardcoding networkId to 'loading'.
      networkId: networkId === 'loading' ? 0 : parseInt(networkId, 10),
    };

    return Common.forCustomChain(MAINNET, customChainParams, hardfork);
  }

  /**
   * Adds a tx to the txlist
   *
   * @param txMeta
   * @fires ${txMeta.id}:unapproved
   */
  addTransaction(txMeta) {
    this.txStateManager.addTransaction(txMeta);
    this.emit(`${txMeta.id}:unapproved`, txMeta);
    this._trackTransactionMetricsEvent(txMeta, TRANSACTION_EVENTS.ADDED);
  }

  /**
   * Wipes the transactions for a given account
   *
   * @param {string} address - hex string of the from address for txs being removed
   */
  wipeTransactions(address) {
    this.txStateManager.wipeTransactions(address);
  }

  /**
   * Add a new unapproved transaction to the pipeline
   *
   * @returns {Promise<string>} the hash of the transaction after being submitted to the network
   * @param {Object} txParams - txParams for the transaction
   * @param {Object} opts - with the key origin to put the origin on the txMeta
   */
  async newUnapprovedTransaction(txParams, opts = {}) {
    log.debug(
      `MetaMaskController newUnapprovedTransaction ${JSON.stringify(txParams)}`,
    );

    const initialTxMeta = await this.addUnapprovedTransaction(
      txParams,
      opts.origin,
    );

    // listen for tx completion (success, fail)
    return new Promise((resolve, reject) => {
      this.txStateManager.once(
        `${initialTxMeta.id}:finished`,
        (finishedTxMeta) => {
          switch (finishedTxMeta.status) {
            case TRANSACTION_STATUSES.SUBMITTED:
              return resolve(finishedTxMeta.hash);
            case TRANSACTION_STATUSES.REJECTED:
              return reject(
                cleanErrorStack(
                  ethErrors.provider.userRejectedRequest(
                    'MetaMask Tx Signature: User denied transaction signature.',
                  ),
                ),
              );
            case TRANSACTION_STATUSES.FAILED:
              return reject(
                cleanErrorStack(
                  ethErrors.rpc.internal(finishedTxMeta.err.message),
                ),
              );
            default:
              return reject(
                cleanErrorStack(
                  ethErrors.rpc.internal(
                    `MetaMask Tx Signature: Unknown problem: ${JSON.stringify(
                      finishedTxMeta.txParams,
                    )}`,
                  ),
                ),
              );
          }
        },
      );
    });
  }

  /**
   * Validates and generates a txMeta with defaults and puts it in txStateManager
   * store.
   *
   * @param txParams
   * @param origin
   * @param transactionType
   * @returns {txMeta}
   */
  async addUnapprovedTransaction(txParams, origin, transactionType) {
    if (
      transactionType !== undefined &&
      !SWAP_TRANSACTION_TYPES.includes(transactionType)
    ) {
      throw new Error(
        `TransactionController - invalid transactionType value: ${transactionType}`,
      );
    }

    // validate
    const normalizedTxParams = txUtils.normalizeTxParams(txParams);
    const eip1559Compatibility = await this.getEIP1559Compatibility();

    txUtils.validateTxParams(normalizedTxParams, eip1559Compatibility);

    /**
     * `generateTxMeta` adds the default txMeta properties to the passed object.
     * These include the tx's `id`. As we use the id for determining order of
     * txes in the tx-state-manager, it is necessary to call the asynchronous
     * method `this._determineTransactionType` after `generateTxMeta`.
     */
    let txMeta = this.txStateManager.generateTxMeta({
      txParams: normalizedTxParams,
      origin,
    });

    if (origin === 'metamask') {
      // Assert the from address is the selected address
      if (normalizedTxParams.from !== this.getSelectedAddress()) {
        throw ethErrors.rpc.internal({
          message: `Internally initiated transaction is using invalid account.`,
          data: {
            origin,
            fromAddress: normalizedTxParams.from,
            selectedAddress: this.getSelectedAddress(),
          },
        });
      }
    } else {
      // Assert that the origin has permissions to initiate transactions from
      // the specified address
      const permittedAddresses = await this.getPermittedAccounts(origin);
      if (!permittedAddresses.includes(normalizedTxParams.from)) {
        throw ethErrors.provider.unauthorized({ data: { origin } });
      }
    }

    const { type, getCodeResponse } = await this._determineTransactionType(
      txParams,
    );
    txMeta.type = transactionType || type;

    // ensure value
    txMeta.txParams.value = txMeta.txParams.value
      ? addHexPrefix(txMeta.txParams.value)
      : '0x0';

    this.addTransaction(txMeta);
    this.emit('newUnapprovedTx', txMeta);

    try {
      txMeta = await this.addTxGasDefaults(txMeta, getCodeResponse);
    } catch (error) {
      log.warn(error);
      txMeta = this.txStateManager.getTransaction(txMeta.id);
      txMeta.loadingDefaults = false;
      this.txStateManager.updateTransaction(
        txMeta,
        'Failed to calculate gas defaults.',
      );
      throw error;
    }

    txMeta.loadingDefaults = false;
    // save txMeta
    this.txStateManager.updateTransaction(
      txMeta,
      'Added new unapproved transaction.',
    );

    return txMeta;
  }

  /**
   * Adds the tx gas defaults: gas && gasPrice
   *
   * @param {Object} txMeta - the txMeta object
   * @param getCodeResponse
   * @returns {Promise<object>} resolves with txMeta
   */
  async addTxGasDefaults(txMeta, getCodeResponse) {
    const eip1559Compatibility =
      txMeta.txParams.type !== TRANSACTION_ENVELOPE_TYPES.LEGACY &&
      (await this.getEIP1559Compatibility());
    const {
      gasPrice: defaultGasPrice,
      maxFeePerGas: defaultMaxFeePerGas,
      maxPriorityFeePerGas: defaultMaxPriorityFeePerGas,
    } = await this._getDefaultGasFees(txMeta, eip1559Compatibility);
    const {
      gasLimit: defaultGasLimit,
      simulationFails,
    } = await this._getDefaultGasLimit(txMeta, getCodeResponse);

    // eslint-disable-next-line no-param-reassign
    txMeta = this.txStateManager.getTransaction(txMeta.id);
    if (simulationFails) {
      txMeta.simulationFails = simulationFails;
    }

    if (eip1559Compatibility) {
      const { eip1559V2Enabled } = this.preferencesStore.getState();
      const advancedGasFeeDefaultValues = this.getAdvancedGasFee();
      if (
        eip1559V2Enabled &&
        Boolean(advancedGasFeeDefaultValues) &&
        !SWAP_TRANSACTION_TYPES.includes(txMeta.type)
      ) {
        txMeta.userFeeLevel = CUSTOM_GAS_ESTIMATE;
        txMeta.txParams.maxFeePerGas = decGWEIToHexWEI(
          advancedGasFeeDefaultValues.maxBaseFee,
        );
        txMeta.txParams.maxPriorityFeePerGas = decGWEIToHexWEI(
          advancedGasFeeDefaultValues.priorityFee,
        );
      } else if (
        txMeta.txParams.gasPrice &&
        !txMeta.txParams.maxFeePerGas &&
        !txMeta.txParams.maxPriorityFeePerGas
      ) {
        // If the dapp has suggested a gas price, but no maxFeePerGas or maxPriorityFeePerGas
        //  then we set maxFeePerGas and maxPriorityFeePerGas to the suggested gasPrice.
        txMeta.txParams.maxFeePerGas = txMeta.txParams.gasPrice;
        txMeta.txParams.maxPriorityFeePerGas = txMeta.txParams.gasPrice;
        if (eip1559V2Enabled && txMeta.origin !== 'metamask') {
          txMeta.userFeeLevel = PRIORITY_LEVELS.DAPP_SUGGESTED;
        } else {
          txMeta.userFeeLevel = CUSTOM_GAS_ESTIMATE;
        }
      } else {
        if (
          (defaultMaxFeePerGas &&
            defaultMaxPriorityFeePerGas &&
            !txMeta.txParams.maxFeePerGas &&
            !txMeta.txParams.maxPriorityFeePerGas) ||
          txMeta.origin === 'metamask'
        ) {
          txMeta.userFeeLevel = GAS_RECOMMENDATIONS.MEDIUM;
        } else if (eip1559V2Enabled) {
          txMeta.userFeeLevel = PRIORITY_LEVELS.DAPP_SUGGESTED;
        } else {
          txMeta.userFeeLevel = CUSTOM_GAS_ESTIMATE;
        }

        if (defaultMaxFeePerGas && !txMeta.txParams.maxFeePerGas) {
          // If the dapp has not set the gasPrice or the maxFeePerGas, then we set maxFeePerGas
          // with the one returned by the gasFeeController, if that is available.
          txMeta.txParams.maxFeePerGas = defaultMaxFeePerGas;
        }

        if (
          defaultMaxPriorityFeePerGas &&
          !txMeta.txParams.maxPriorityFeePerGas
        ) {
          // If the dapp has not set the gasPrice or the maxPriorityFeePerGas, then we set maxPriorityFeePerGas
          // with the one returned by the gasFeeController, if that is available.
          txMeta.txParams.maxPriorityFeePerGas = defaultMaxPriorityFeePerGas;
        }

        if (defaultGasPrice && !txMeta.txParams.maxFeePerGas) {
          // If the dapp has not set the gasPrice or the maxFeePerGas, and no maxFeePerGas is available
          // from the gasFeeController, then we set maxFeePerGas to the defaultGasPrice, assuming it is
          // available.
          txMeta.txParams.maxFeePerGas = defaultGasPrice;
        }

        if (
          txMeta.txParams.maxFeePerGas &&
          !txMeta.txParams.maxPriorityFeePerGas
        ) {
          // If the dapp has not set the gasPrice or the maxPriorityFeePerGas, and no maxPriorityFeePerGas is
          // available from the gasFeeController, then we set maxPriorityFeePerGas to
          // txMeta.txParams.maxFeePerGas, which will either be the gasPrice from the controller, the maxFeePerGas
          // set by the dapp, or the maxFeePerGas from the controller.
          txMeta.txParams.maxPriorityFeePerGas = txMeta.txParams.maxFeePerGas;
        }
      }

      // We remove the gasPrice param entirely when on an eip1559 compatible network

      delete txMeta.txParams.gasPrice;
    } else {
      // We ensure that maxFeePerGas and maxPriorityFeePerGas are not in the transaction params
      // when not on a EIP1559 compatible network

      delete txMeta.txParams.maxPriorityFeePerGas;
      delete txMeta.txParams.maxFeePerGas;
    }

    // If we have gotten to this point, and none of gasPrice, maxPriorityFeePerGas or maxFeePerGas are
    // set on txParams, it means that either we are on a non-EIP1559 network and the dapp didn't suggest
    // a gas price, or we are on an EIP1559 network, and none of gasPrice, maxPriorityFeePerGas or maxFeePerGas
    // were available from either the dapp or the network.
    if (
      defaultGasPrice &&
      !txMeta.txParams.gasPrice &&
      !txMeta.txParams.maxPriorityFeePerGas &&
      !txMeta.txParams.maxFeePerGas
    ) {
      txMeta.txParams.gasPrice = defaultGasPrice;
    }

    if (defaultGasLimit && !txMeta.txParams.gas) {
      txMeta.txParams.gas = defaultGasLimit;
      txMeta.originalGasEstimate = defaultGasLimit;
    }
    txMeta.defaultGasEstimates = {
      estimateType: txMeta.userFeeLevel,
      gas: txMeta.txParams.gas,
      gasPrice: txMeta.txParams.gasPrice,
      maxFeePerGas: txMeta.txParams.maxFeePerGas,
      maxPriorityFeePerGas: txMeta.txParams.maxPriorityFeePerGas,
    };
    return txMeta;
  }

  /**
   * Gets default gas fees, or returns `undefined` if gas fees are already set
   *
   * @param {Object} txMeta - The txMeta object
   * @param eip1559Compatibility
   * @returns {Promise<string|undefined>} The default gas price
   */
  async _getDefaultGasFees(txMeta, eip1559Compatibility) {
    if (
      (!eip1559Compatibility && txMeta.txParams.gasPrice) ||
      (eip1559Compatibility &&
        txMeta.txParams.maxFeePerGas &&
        txMeta.txParams.maxPriorityFeePerGas)
    ) {
      return {};
    }

    try {
      const {
        gasFeeEstimates,
        gasEstimateType,
      } = await this._getEIP1559GasFeeEstimates();
      if (
        eip1559Compatibility &&
        gasEstimateType === GAS_ESTIMATE_TYPES.FEE_MARKET
      ) {
        const {
          medium: { suggestedMaxPriorityFeePerGas, suggestedMaxFeePerGas } = {},
        } = gasFeeEstimates;

        if (suggestedMaxPriorityFeePerGas && suggestedMaxFeePerGas) {
          return {
            maxFeePerGas: decGWEIToHexWEI(suggestedMaxFeePerGas),
            maxPriorityFeePerGas: decGWEIToHexWEI(
              suggestedMaxPriorityFeePerGas,
            ),
          };
        }
      } else if (gasEstimateType === GAS_ESTIMATE_TYPES.LEGACY) {
        // The LEGACY type includes low, medium and high estimates of
        // gas price values.
        return {
          gasPrice: decGWEIToHexWEI(gasFeeEstimates.medium),
        };
      } else if (gasEstimateType === GAS_ESTIMATE_TYPES.ETH_GASPRICE) {
        // The ETH_GASPRICE type just includes a single gas price property,
        // which we can assume was retrieved from eth_gasPrice
        return {
          gasPrice: decGWEIToHexWEI(gasFeeEstimates.gasPrice),
        };
      }
    } catch (e) {
      console.error(e);
    }

    const gasPrice = await this.query.gasPrice();

    return { gasPrice: gasPrice && addHexPrefix(gasPrice.toString(16)) };
  }

  /**
   * Gets default gas limit, or debug information about why gas estimate failed.
   *
   * @param {Object} txMeta - The txMeta object
   * @param {string} getCodeResponse - The transaction category code response, used for debugging purposes
   * @returns {Promise<Object>} Object containing the default gas limit, or the simulation failure object
   */
  async _getDefaultGasLimit(txMeta, getCodeResponse) {
    const chainId = this._getCurrentChainId();
    const customNetworkGasBuffer = CHAIN_ID_TO_GAS_LIMIT_BUFFER_MAP[chainId];
    const chainType = getChainType(chainId);

    if (txMeta.txParams.gas) {
      return {};
    } else if (
      txMeta.txParams.to &&
      txMeta.type === TRANSACTION_TYPES.SIMPLE_SEND &&
      chainType !== 'custom'
    ) {
      // if there's data in the params, but there's no contract code, it's not a valid transaction
      if (txMeta.txParams.data) {
        const err = new Error(
          'TxGasUtil - Trying to call a function on a non-contract address',
        );
        // set error key so ui can display localized error message
        err.errorKey = TRANSACTION_NO_CONTRACT_ERROR_KEY;

        // set the response on the error so that we can see in logs what the actual response was
        err.getCodeResponse = getCodeResponse;
        throw err;
      }

      // This is a standard ether simple send, gas requirement is exactly 21k
      return { gasLimit: GAS_LIMITS.SIMPLE };
    }

    const {
      blockGasLimit,
      estimatedGasHex,
      simulationFails,
    } = await this.txGasUtil.analyzeGasUsage(txMeta);

    // add additional gas buffer to our estimation for safety
    const gasLimit = this.txGasUtil.addGasBuffer(
      addHexPrefix(estimatedGasHex),
      blockGasLimit,
      customNetworkGasBuffer,
    );
    return { gasLimit, simulationFails };
  }

  /**
   * Given a TransactionMeta object, generate new gas params such that if the
   * transaction was an EIP1559 transaction, it only has EIP1559 gas fields,
   * otherwise it only has gasPrice. Will use whatever custom values are
   * specified in customGasSettings, or falls back to incrementing by a percent
   * which is defined by specifying a numerator. 11 is a 10% bump, 12 would be
   * a 20% bump, and so on.
   *
   * @param {TransactionMeta} originalTxMeta - Original transaction to use as
   *  base
   * @param {CustomGasSettings} [customGasSettings] - overrides for the gas
   *  fields to use instead of the multiplier
   * @param {number} [incrementNumerator] - Numerator from which to generate a
   *  percentage bump of gas price. E.g 11 would be a 10% bump over base.
   * @returns {{ newGasParams: CustomGasSettings, previousGasParams: CustomGasSettings }}
   */
  generateNewGasParams(
    originalTxMeta,
    customGasSettings = {},
    incrementNumerator = 11,
  ) {
    const { txParams } = originalTxMeta;
    const previousGasParams = {};
    const newGasParams = {};
    if (customGasSettings.gasLimit) {
      newGasParams.gas = customGasSettings?.gas ?? GAS_LIMITS.SIMPLE;
    }

    if (customGasSettings.estimateSuggested) {
      newGasParams.estimateSuggested = customGasSettings.estimateSuggested;
    }

    if (customGasSettings.estimateUsed) {
      newGasParams.estimateUsed = customGasSettings.estimateUsed;
    }

    if (isEIP1559Transaction(originalTxMeta)) {
      previousGasParams.maxFeePerGas = txParams.maxFeePerGas;
      previousGasParams.maxPriorityFeePerGas = txParams.maxPriorityFeePerGas;
      newGasParams.maxFeePerGas =
        customGasSettings?.maxFeePerGas ||
        bnToHex(
          BnMultiplyByFraction(
            hexToBn(txParams.maxFeePerGas),
            incrementNumerator,
            10,
          ),
        );
      newGasParams.maxPriorityFeePerGas =
        customGasSettings?.maxPriorityFeePerGas ||
        bnToHex(
          BnMultiplyByFraction(
            hexToBn(txParams.maxPriorityFeePerGas),
            incrementNumerator,
            10,
          ),
        );
    } else {
      previousGasParams.gasPrice = txParams.gasPrice;
      newGasParams.gasPrice =
        customGasSettings?.gasPrice ||
        bnToHex(
          BnMultiplyByFraction(
            hexToBn(txParams.gasPrice),
            incrementNumerator,
            10,
          ),
        );
    }

    return { previousGasParams, newGasParams };
  }

  /**
   * Creates a new approved transaction to attempt to cancel a previously submitted transaction. The
   * new transaction contains the same nonce as the previous, is a basic ETH transfer of 0x value to
   * the sender's address, and has a higher gasPrice than that of the previous transaction.
   *
   * @param {number} originalTxId - the id of the txMeta that you want to attempt to cancel
   * @param {CustomGasSettings} [customGasSettings] - overrides to use for gas
   *  params instead of allowing this method to generate them
   * @param options
   * @param options.estimatedBaseFee
   * @returns {txMeta}
   */
  async createCancelTransaction(
    originalTxId,
    customGasSettings,
    { estimatedBaseFee } = {},
  ) {
    const originalTxMeta = this.txStateManager.getTransaction(originalTxId);
    const { txParams } = originalTxMeta;
    const { from, nonce } = txParams;

    const { previousGasParams, newGasParams } = this.generateNewGasParams(
      originalTxMeta,
      {
        ...customGasSettings,
        // We want to override the previous transactions gasLimit because it
        // will now be a simple send instead of whatever it was before such
        // as a token transfer or contract call.
        gasLimit: customGasSettings.gasLimit || GAS_LIMITS.SIMPLE,
      },
    );

    const newTxMeta = this.txStateManager.generateTxMeta({
      txParams: {
        from,
        to: from,
        nonce,
        value: '0x0',
        ...newGasParams,
      },
      previousGasParams,
      loadingDefaults: false,
      status: TRANSACTION_STATUSES.APPROVED,
      type: TRANSACTION_TYPES.CANCEL,
    });

    if (estimatedBaseFee) {
      newTxMeta.estimatedBaseFee = estimatedBaseFee;
    }

    this.addTransaction(newTxMeta);
    await this.approveTransaction(newTxMeta.id);
    return newTxMeta;
  }

  /**
   * Creates a new approved transaction to attempt to speed up a previously submitted transaction. The
   * new transaction contains the same nonce as the previous. By default, the new transaction will use
   * the same gas limit and a 10% higher gas price, though it is possible to set a custom value for
   * each instead.
   *
   * @param {number} originalTxId - the id of the txMeta that you want to speed up
   * @param {CustomGasSettings} [customGasSettings] - overrides to use for gas
   *  params instead of allowing this method to generate them
   * @param options
   * @param options.estimatedBaseFee
   * @returns {txMeta}
   */
  async createSpeedUpTransaction(
    originalTxId,
    customGasSettings,
    { estimatedBaseFee } = {},
  ) {
    const originalTxMeta = this.txStateManager.getTransaction(originalTxId);
    const { txParams } = originalTxMeta;

    const { previousGasParams, newGasParams } = this.generateNewGasParams(
      originalTxMeta,
      customGasSettings,
    );

    const newTxMeta = this.txStateManager.generateTxMeta({
      txParams: {
        ...txParams,
        ...newGasParams,
      },
      previousGasParams,
      loadingDefaults: false,
      status: TRANSACTION_STATUSES.APPROVED,
      type: TRANSACTION_TYPES.RETRY,
    });

    if (estimatedBaseFee) {
      newTxMeta.estimatedBaseFee = estimatedBaseFee;
    }

    this.addTransaction(newTxMeta);
    await this.approveTransaction(newTxMeta.id);
    return newTxMeta;
  }

  /**
   * updates the txMeta in the txStateManager
   *
   * @param {Object} txMeta - the updated txMeta
   */
  async updateTransaction(txMeta) {
    this.txStateManager.updateTransaction(
      txMeta,
      'confTx: user updated transaction',
    );
  }

  /**
   * updates and approves the transaction
   *
   * @param {Object} txMeta
   */
  async updateAndApproveTransaction(txMeta) {
    this.txStateManager.updateTransaction(
      txMeta,
      'confTx: user approved transaction',
    );
    await this.approveTransaction(txMeta.id);
  }

  /**
   * sets the tx status to approved
   * auto fills the nonce
   * signs the transaction
   * publishes the transaction
   * if any of these steps fails the tx status will be set to failed
   *
   * @param {number} txId - the tx's Id
   */
  async approveTransaction(txId) {
    // TODO: Move this safety out of this function.
    // Since this transaction is async,
    // we need to keep track of what is currently being signed,
    // So that we do not increment nonce + resubmit something
    // that is already being incremented & signed.
    if (this.inProcessOfSigning.has(txId)) {
      return;
    }
    this.inProcessOfSigning.add(txId);
    let nonceLock;
    try {
      // approve
      this.txStateManager.setTxStatusApproved(txId);
      // get next nonce
      const txMeta = this.txStateManager.getTransaction(txId);

      const fromAddress = txMeta.txParams.from;
      // wait for a nonce
      let { customNonceValue } = txMeta;
      customNonceValue = Number(customNonceValue);
      nonceLock = await this.nonceTracker.getNonceLock(fromAddress);
      // add nonce to txParams
      // if txMeta has previousGasParams then it is a retry at same nonce with
      // higher gas settings and therefor the nonce should not be recalculated
      const nonce = txMeta.previousGasParams
        ? txMeta.txParams.nonce
        : nonceLock.nextNonce;
      const customOrNonce =
        customNonceValue === 0 ? customNonceValue : customNonceValue || nonce;

      txMeta.txParams.nonce = addHexPrefix(customOrNonce.toString(16));
      // add nonce debugging information to txMeta
      txMeta.nonceDetails = nonceLock.nonceDetails;
      if (customNonceValue) {
        txMeta.nonceDetails.customNonceValue = customNonceValue;
      }
      this.txStateManager.updateTransaction(
        txMeta,
        'transactions#approveTransaction',
      );
      // sign transaction
      const rawTx = await this.signTransaction(txId);
      await this.publishTransaction(txId, rawTx);
      this._trackTransactionMetricsEvent(txMeta, TRANSACTION_EVENTS.APPROVED);
      // must set transaction to submitted/failed before releasing lock
      nonceLock.releaseLock();
    } catch (err) {
      // this is try-catch wrapped so that we can guarantee that the nonceLock is released
      try {
        this._failTransaction(txId, err);
      } catch (err2) {
        log.error(err2);
      }
      // must set transaction to submitted/failed before releasing lock
      if (nonceLock) {
        nonceLock.releaseLock();
      }
      // continue with error chain
      throw err;
    } finally {
      this.inProcessOfSigning.delete(txId);
    }
  }

  /**
   * adds the chain id and signs the transaction and set the status to signed
   *
   * @param {number} txId - the tx's Id
   * @returns {string} rawTx
   */
  async signTransaction(txId) {
    const txMeta = this.txStateManager.getTransaction(txId);
    // add network/chain id
    const chainId = this.getChainId();
    const type = isEIP1559Transaction(txMeta)
      ? TRANSACTION_ENVELOPE_TYPES.FEE_MARKET
      : TRANSACTION_ENVELOPE_TYPES.LEGACY;
    const txParams = {
      ...txMeta.txParams,
      type,
      chainId,
      gasLimit: txMeta.txParams.gas,
    };
    // sign tx
    const fromAddress = txParams.from;
    const common = await this.getCommonConfiguration(txParams.from);
    const unsignedEthTx = TransactionFactory.fromTxData(txParams, { common });
    const signedEthTx = await this.signEthTx(unsignedEthTx, fromAddress);

    // add r,s,v values for provider request purposes see createMetamaskMiddleware
    // and JSON rpc standard for further explanation
    txMeta.r = bufferToHex(signedEthTx.r);
    txMeta.s = bufferToHex(signedEthTx.s);
    txMeta.v = bufferToHex(signedEthTx.v);

    this.txStateManager.updateTransaction(
      txMeta,
      'transactions#signTransaction: add r, s, v values',
    );

    // set state to signed
    this.txStateManager.setTxStatusSigned(txMeta.id);
    const rawTx = bufferToHex(signedEthTx.serialize());
    return rawTx;
  }

  /**
   * publishes the raw tx and sets the txMeta to submitted
   *
   * @param {number} txId - the tx's Id
   * @param {string} rawTx - the hex string of the serialized signed transaction
   * @returns {Promise<void>}
   */
  async publishTransaction(txId, rawTx) {
    const txMeta = this.txStateManager.getTransaction(txId);
    txMeta.rawTx = rawTx;
    if (txMeta.type === TRANSACTION_TYPES.SWAP) {
      const preTxBalance = await this.query.getBalance(txMeta.txParams.from);
      txMeta.preTxBalance = preTxBalance.toString(16);
    }
    this.txStateManager.updateTransaction(
      txMeta,
      'transactions#publishTransaction',
    );
    let txHash;
    try {
      txHash = await this.query.sendRawTransaction(rawTx);
    } catch (error) {
      if (error.message.toLowerCase().includes('known transaction')) {
        txHash = keccak(toBuffer(addHexPrefix(rawTx), 'hex')).toString('hex');
        txHash = addHexPrefix(txHash);
      } else {
        throw error;
      }
    }
    this.setTxHash(txId, txHash);

    this.txStateManager.setTxStatusSubmitted(txId);

    this._trackTransactionMetricsEvent(txMeta, TRANSACTION_EVENTS.SUBMITTED);
  }

  /**
   * Sets the status of the transaction to confirmed and sets the status of nonce duplicates as
   * dropped if the txParams have data it will fetch the txReceipt
   *
   * @param {number} txId - The tx's ID
   * @param txReceipt
   * @param baseFeePerGas
   * @param blockTimestamp
   * @returns {Promise<void>}
   */
  async confirmTransaction(txId, txReceipt, baseFeePerGas, blockTimestamp) {
    // get the txReceipt before marking the transaction confirmed
    // to ensure the receipt is gotten before the ui revives the tx
    const txMeta = this.txStateManager.getTransaction(txId);

    if (!txMeta) {
      return;
    }

    try {
      // It seems that sometimes the numerical values being returned from
      // this.query.getTransactionReceipt are BN instances and not strings.
      const gasUsed =
        typeof txReceipt.gasUsed === 'string'
          ? txReceipt.gasUsed
          : txReceipt.gasUsed.toString(16);

      txMeta.txReceipt = {
        ...txReceipt,
        gasUsed,
      };

      if (baseFeePerGas) {
        txMeta.baseFeePerGas = baseFeePerGas;
      }
      if (blockTimestamp) {
        txMeta.blockTimestamp = blockTimestamp;
      }

      this.txStateManager.setTxStatusConfirmed(txId);
      this._markNonceDuplicatesDropped(txId);

      const { submittedTime } = txMeta;
      const metricsParams = { gas_used: gasUsed };

      if (submittedTime) {
        metricsParams.completion_time = this._getTransactionCompletionTime(
          submittedTime,
        );
      }

      if (txReceipt.status === '0x0') {
        metricsParams.status = 'failed on-chain';
        // metricsParams.error = TODO: figure out a way to get the on-chain failure reason
      }

      this._trackTransactionMetricsEvent(
        txMeta,
        TRANSACTION_EVENTS.FINALIZED,
        metricsParams,
      );

      this.txStateManager.updateTransaction(
        txMeta,
        'transactions#confirmTransaction - add txReceipt',
      );

      if (txMeta.type === TRANSACTION_TYPES.SWAP) {
        const postTxBalance = await this.query.getBalance(txMeta.txParams.from);
        const latestTxMeta = this.txStateManager.getTransaction(txId);

        const approvalTxMeta = latestTxMeta.approvalTxId
          ? this.txStateManager.getTransaction(latestTxMeta.approvalTxId)
          : null;

        latestTxMeta.postTxBalance = postTxBalance.toString(16);

        this.txStateManager.updateTransaction(
          latestTxMeta,
          'transactions#confirmTransaction - add postTxBalance',
        );

        this._trackSwapsMetrics(latestTxMeta, approvalTxMeta);
      }
    } catch (err) {
      log.error(err);
    }
  }

  /**
   * Convenience method for the ui thats sets the transaction to rejected
   *
   * @param {number} txId - the tx's Id
   * @returns {Promise<void>}
   */
  async cancelTransaction(txId) {
    const txMeta = this.txStateManager.getTransaction(txId);
    this.txStateManager.setTxStatusRejected(txId);
    this._trackTransactionMetricsEvent(txMeta, TRANSACTION_EVENTS.REJECTED);
  }

  /**
   * Sets the txHas on the txMeta
   *
   * @param {number} txId - the tx's Id
   * @param {string} txHash - the hash for the txMeta
   */
  setTxHash(txId, txHash) {
    // Add the tx hash to the persisted meta-tx object
    const txMeta = this.txStateManager.getTransaction(txId);
    txMeta.hash = txHash;
    this.txStateManager.updateTransaction(txMeta, 'transactions#setTxHash');
  }

  /**
   * Convenience method for the UI to easily create event fragments when the
   * fragment does not exist in state.
   *
   * @param {number} transactionId - The transaction id to create the event
   *  fragment for
   * @param {valueOf<TRANSACTION_EVENTS>} event - event type to create
   */
  async createTransactionEventFragment(transactionId, event) {
    const txMeta = this.txStateManager.getTransaction(transactionId);
    const {
      properties,
      sensitiveProperties,
    } = await this._buildEventFragmentProperties(txMeta);
    this._createTransactionEventFragment(
      txMeta,
      event,
      properties,
      sensitiveProperties,
    );
  }

  //
  //           PRIVATE METHODS
  //
  /** maps methods for convenience*/
  _mapMethods() {
    /** @returns {Object} the state in transaction controller */
    this.getState = () => this.memStore.getState();

    /** @returns {string|number} the network number stored in networkStore */
    this.getNetwork = () => this.networkStore.getState();

    /** @returns {string} the user selected address */
    this.getSelectedAddress = () =>
      this.preferencesStore.getState().selectedAddress;

    /** @returns {Array} transactions whos status is unapproved */
    this.getUnapprovedTxCount = () =>
      Object.keys(this.txStateManager.getUnapprovedTxList()).length;

    /**
     * @returns {number} number of transactions that have the status submitted
     * @param {string} account - hex prefixed account
     */
    this.getPendingTxCount = (account) =>
      this.txStateManager.getPendingTransactions(account).length;

    /**
     * see txStateManager
     *
     * @param opts
     */
    this.getTransactions = (opts) => this.txStateManager.getTransactions(opts);

    /** @returns {object} the saved default values for advancedGasFee */
    this.getAdvancedGasFee = () =>
      this.preferencesStore.getState().advancedGasFee;
  }

  // called once on startup
  async _updatePendingTxsAfterFirstBlock() {
    // wait for first block so we know we're ready
    await this.blockTracker.getLatestBlock();
    // get status update for all pending transactions (for the current network)
    await this.pendingTxTracker.updatePendingTxs();
  }

  /**
   * If transaction controller was rebooted with transactions that are uncompleted
   * in steps of the transaction signing or user confirmation process it will either
   * transition txMetas to a failed state or try to redo those tasks.
   */

  _onBootCleanUp() {
    this.txStateManager
      .getTransactions({
        searchCriteria: {
          status: TRANSACTION_STATUSES.UNAPPROVED,
          loadingDefaults: true,
        },
      })
      .forEach((tx) => {
        this.addTxGasDefaults(tx)
          .then((txMeta) => {
            txMeta.loadingDefaults = false;
            this.txStateManager.updateTransaction(
              txMeta,
              'transactions: gas estimation for tx on boot',
            );
          })
          .catch((error) => {
            const txMeta = this.txStateManager.getTransaction(tx.id);
            txMeta.loadingDefaults = false;
            this.txStateManager.updateTransaction(
              txMeta,
              'failed to estimate gas during boot cleanup.',
            );
            this._failTransaction(txMeta.id, error);
          });
      });

    this.txStateManager
      .getTransactions({
        searchCriteria: {
          status: TRANSACTION_STATUSES.APPROVED,
        },
      })
      .forEach((txMeta) => {
        const txSignError = new Error(
          'Transaction found as "approved" during boot - possibly stuck during signing',
        );
        this._failTransaction(txMeta.id, txSignError);
      });
  }

  /**
   * is called in constructor applies the listeners for pendingTxTracker txStateManager
   * and blockTracker
   */
  _setupListeners() {
    this.txStateManager.on(
      'tx:status-update',
      this.emit.bind(this, 'tx:status-update'),
    );
    this._setupBlockTrackerListener();
    this.pendingTxTracker.on('tx:warning', (txMeta) => {
      this.txStateManager.updateTransaction(
        txMeta,
        'transactions/pending-tx-tracker#event: tx:warning',
      );
    });
    this.pendingTxTracker.on('tx:failed', (txId, error) => {
      this._failTransaction(txId, error);
    });
    this.pendingTxTracker.on(
      'tx:confirmed',
      (txId, transactionReceipt, baseFeePerGas, blockTimestamp) =>
        this.confirmTransaction(
          txId,
          transactionReceipt,
          baseFeePerGas,
          blockTimestamp,
        ),
    );
    this.pendingTxTracker.on('tx:dropped', (txId) => {
      this._dropTransaction(txId);
    });
    this.pendingTxTracker.on('tx:block-update', (txMeta, latestBlockNumber) => {
      if (!txMeta.firstRetryBlockNumber) {
        txMeta.firstRetryBlockNumber = latestBlockNumber;
        this.txStateManager.updateTransaction(
          txMeta,
          'transactions/pending-tx-tracker#event: tx:block-update',
        );
      }
    });
    this.pendingTxTracker.on('tx:retry', (txMeta) => {
      if (!('retryCount' in txMeta)) {
        txMeta.retryCount = 0;
      }
      txMeta.retryCount += 1;
      this.txStateManager.updateTransaction(
        txMeta,
        'transactions/pending-tx-tracker#event: tx:retry',
      );
    });
  }

  /**
   * @typedef { 'transfer' | 'approve' | 'transferfrom' | 'contractInteraction'| 'simpleSend' } InferrableTransactionTypes
   */

  /**
   * @typedef {Object} InferTransactionTypeResult
   * @property {InferrableTransactionTypes} type - The type of transaction
   * @property {string} getCodeResponse - The contract code, in hex format if
   *  it exists. '0x0' or '0x' are also indicators of non-existent contract
   *  code
   */

  /**
   * Determines the type of the transaction by analyzing the txParams.
   * This method will return one of the types defined in shared/constants/transactions
   * It will never return TRANSACTION_TYPE_CANCEL or TRANSACTION_TYPE_RETRY as these
   * represent specific events that we control from the extension and are added manually
   * at transaction creation.
   *
   * @param {Object} txParams - Parameters for the transaction
   * @returns {InferTransactionTypeResult}
   */
  async _determineTransactionType(txParams) {
    const { data, to } = txParams;
    let name;
    try {
      name = data && hstInterface.parseTransaction({ data }).name;
    } catch (error) {
      log.debug('Failed to parse transaction data.', error, data);
    }

    const tokenMethodName = [
      TRANSACTION_TYPES.TOKEN_METHOD_APPROVE,
      TRANSACTION_TYPES.TOKEN_METHOD_TRANSFER,
      TRANSACTION_TYPES.TOKEN_METHOD_TRANSFER_FROM,
    ].find((methodName) => isEqualCaseInsensitive(methodName, name));

    let result;
    if (data && tokenMethodName) {
      result = tokenMethodName;
    } else if (data && !to) {
      result = TRANSACTION_TYPES.DEPLOY_CONTRACT;
    }

    let contractCode;

    if (!result) {
      const {
        contractCode: resultCode,
        isContractAddress,
      } = await readAddressAsContract(this.query, to);

      contractCode = resultCode;
      result = isContractAddress
        ? TRANSACTION_TYPES.CONTRACT_INTERACTION
        : TRANSACTION_TYPES.SIMPLE_SEND;
    }

    return { type: result, getCodeResponse: contractCode };
  }

  /**
   * Sets other txMeta statuses to dropped if the txMeta that has been confirmed has other transactions
   * in the list have the same nonce
   *
   * @param {number} txId - the txId of the transaction that has been confirmed in a block
   */
  _markNonceDuplicatesDropped(txId) {
    // get the confirmed transactions nonce and from address
    const txMeta = this.txStateManager.getTransaction(txId);
    const { nonce, from } = txMeta.txParams;
    const sameNonceTxs = this.txStateManager.getTransactions({
      searchCriteria: { nonce, from },
    });
    if (!sameNonceTxs.length) {
      return;
    }
    // mark all same nonce transactions as dropped and give i a replacedBy hash
    sameNonceTxs.forEach((otherTxMeta) => {
      if (otherTxMeta.id === txId) {
        return;
      }
      otherTxMeta.replacedBy = txMeta.hash;
      this.txStateManager.updateTransaction(
        txMeta,
        'transactions/pending-tx-tracker#event: tx:confirmed reference to confirmed txHash with same nonce',
      );
      this._dropTransaction(otherTxMeta.id);
    });
  }

  _setupBlockTrackerListener() {
    let listenersAreActive = false;
    const latestBlockHandler = this._onLatestBlock.bind(this);
    const { blockTracker, txStateManager } = this;

    txStateManager.on('tx:status-update', updateSubscription);
    updateSubscription();

    function updateSubscription() {
      const pendingTxs = txStateManager.getPendingTransactions();
      if (!listenersAreActive && pendingTxs.length > 0) {
        blockTracker.on('latest', latestBlockHandler);
        listenersAreActive = true;
      } else if (listenersAreActive && !pendingTxs.length) {
        blockTracker.removeListener('latest', latestBlockHandler);
        listenersAreActive = false;
      }
    }
  }

  async _onLatestBlock(blockNumber) {
    try {
      await this.pendingTxTracker.updatePendingTxs();
    } catch (err) {
      log.error(err);
    }
    try {
      await this.pendingTxTracker.resubmitPendingTxs(blockNumber);
    } catch (err) {
      log.error(err);
    }
  }

  /**
   * Updates the memStore in transaction controller
   */
  _updateMemstore() {
    const unapprovedTxs = this.txStateManager.getUnapprovedTxList();
    const currentNetworkTxList = this.txStateManager.getTransactions({
      limit: MAX_MEMSTORE_TX_LIST_SIZE,
    });
    this.memStore.updateState({ unapprovedTxs, currentNetworkTxList });
  }

  _trackSwapsMetrics(txMeta, approvalTxMeta) {
    if (this._getParticipateInMetrics() && txMeta.swapMetaData) {
      if (txMeta.txReceipt.status === '0x0') {
        this._trackMetaMetricsEvent({
          event: 'Swap Failed',
          sensitiveProperties: { ...txMeta.swapMetaData },
          category: 'swaps',
        });
      } else {
        const tokensReceived = getSwapsTokensReceivedFromTxMeta(
          txMeta.destinationTokenSymbol,
          txMeta,
          txMeta.destinationTokenAddress,
          txMeta.txParams.from,
          txMeta.destinationTokenDecimals,
          approvalTxMeta,
          txMeta.chainId,
        );

        const quoteVsExecutionRatio = tokensReceived
          ? `${new BigNumber(tokensReceived, 10)
              .div(txMeta.swapMetaData.token_to_amount, 10)
              .times(100)
              .round(2)}%`
          : null;

        const estimatedVsUsedGasRatio = `${new BigNumber(
          txMeta.txReceipt.gasUsed,
          16,
        )
          .div(txMeta.swapMetaData.estimated_gas, 10)
          .times(100)
          .round(2)}%`;

        this._trackMetaMetricsEvent({
          event: 'Swap Completed',
          category: 'swaps',
          sensitiveProperties: {
            ...txMeta.swapMetaData,
            token_to_amount_received: tokensReceived,
            quote_vs_executionRatio: quoteVsExecutionRatio,
            estimated_vs_used_gasRatio: estimatedVsUsedGasRatio,
          },
        });
      }
    }
  }

  async _buildEventFragmentProperties(txMeta, extraParams) {
    const {
      type,
      time,
      status,
      chainId,
      origin: referrer,
      txParams: {
        gasPrice,
        gas: gasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas,
        estimateSuggested,
        estimateUsed,
      },
      defaultGasEstimates,
      metamaskNetworkId: network,
    } = txMeta;
    const source = referrer === 'metamask' ? 'user' : 'dapp';

    const gasParams = {};

    if (isEIP1559Transaction(txMeta)) {
      gasParams.max_fee_per_gas = maxFeePerGas;
      gasParams.max_priority_fee_per_gas = maxPriorityFeePerGas;
    } else {
      gasParams.gas_price = gasPrice;
    }

    if (defaultGasEstimates) {
      const { estimateType } = defaultGasEstimates;
      if (estimateType) {
        gasParams.default_estimate = estimateType;
        let defaultMaxFeePerGas = txMeta.defaultGasEstimates.maxFeePerGas;
        let defaultMaxPriorityFeePerGas =
          txMeta.defaultGasEstimates.maxPriorityFeePerGas;

        if (
          [
            GAS_RECOMMENDATIONS.LOW,
            GAS_RECOMMENDATIONS.MEDIUM,
            GAS_RECOMMENDATIONS.MEDIUM.HIGH,
          ].includes(estimateType)
        ) {
          const { gasFeeEstimates } = await this._getEIP1559GasFeeEstimates();
          if (gasFeeEstimates?.[estimateType]?.suggestedMaxFeePerGas) {
            defaultMaxFeePerGas =
              gasFeeEstimates[estimateType]?.suggestedMaxFeePerGas;
            gasParams.default_max_fee_per_gas = defaultMaxFeePerGas;
          }
          if (gasFeeEstimates?.[estimateType]?.suggestedMaxPriorityFeePerGas) {
            defaultMaxPriorityFeePerGas =
              gasFeeEstimates[estimateType]?.suggestedMaxPriorityFeePerGas;
            gasParams.default_max_priority_fee_per_gas = defaultMaxPriorityFeePerGas;
          }
        }
      }

      if (txMeta.defaultGasEstimates.gas) {
        gasParams.default_gas = txMeta.defaultGasEstimates.gas;
      }
      if (txMeta.defaultGasEstimates.gasPrice) {
        gasParams.default_gas_price = txMeta.defaultGasEstimates.gasPrice;
      }
    }

    if (estimateSuggested) {
      gasParams.estimate_suggested = estimateSuggested;
    }

    if (estimateUsed) {
      gasParams.estimate_used = estimateUsed;
    }

    const gasParamsInGwei = this._getGasValuesInGWEI(gasParams);

    let eip1559Version = '0';
    if (txMeta.txParams.maxFeePerGas) {
      const { eip1559V2Enabled } = this.preferencesStore.getState();
      eip1559Version = eip1559V2Enabled ? '2' : '1';
    }

    const properties = {
      chain_id: chainId,
      referrer,
      source,
      network,
      type,
      eip_1559_version: eip1559Version,
      gas_edit_type: 'none',
      gas_edit_attempted: 'none',
    };

    const sensitiveProperties = {
      status,
      transaction_envelope_type: isEIP1559Transaction(txMeta)
        ? TRANSACTION_ENVELOPE_TYPE_NAMES.FEE_MARKET
        : TRANSACTION_ENVELOPE_TYPE_NAMES.LEGACY,
      first_seen: time,
      gas_limit: gasLimit,
      ...gasParamsInGwei,
      ...extraParams,
    };

    return { properties, sensitiveProperties };
  }

  /**
   * Helper method that checks for the presence of an existing fragment by id
   * appropriate for the type of event that triggered fragment creation. If the
   * appropriate fragment exists, then nothing is done. If it does not exist a
   * new event fragment is created with the appropriate payload.
   *
   * @param {TransactionMeta} txMeta - Transaction meta object
   * @param {TransactionMetaMetricsEventString} event - The event type that
   *  triggered fragment creation
   * @param {Object} properties - properties to include in the fragment
   * @param {Object} [sensitiveProperties] - sensitive properties to include in
   *  the fragment
   */
  _createTransactionEventFragment(
    txMeta,
    event,
    properties,
    sensitiveProperties,
  ) {
    const isSubmitted = [
      TRANSACTION_EVENTS.FINALIZED,
      TRANSACTION_EVENTS.SUBMITTED,
    ].includes(event);
    const uniqueIdentifier = `transaction-${
      isSubmitted ? 'submitted' : 'added'
    }-${txMeta.id}`;

    const fragment = this.getEventFragmentById(uniqueIdentifier);
    if (typeof fragment !== 'undefined') {
      return;
    }

    switch (event) {
      // When a transaction is added to the controller, we know that the user
      // will be presented with a confirmation screen. The user will then
      // either confirm or reject that transaction. Each has an associated
      // event we want to track. While we don't necessarily need an event
      // fragment to model this, having one allows us to record additional
      // properties onto the event from the UI. For example, when the user
      // edits the transactions gas params we can record that property and
      // then get analytics on the number of transactions in which gas edits
      // occur.
      case TRANSACTION_EVENTS.ADDED:
        this.createEventFragment({
          category: 'Transactions',
          initialEvent: TRANSACTION_EVENTS.ADDED,
          successEvent: TRANSACTION_EVENTS.APPROVED,
          failureEvent: TRANSACTION_EVENTS.REJECTED,
          properties,
          sensitiveProperties,
          persist: true,
          uniqueIdentifier,
        });
        break;
      // If for some reason an approval or rejection occurs without the added
      // fragment existing in memory, we create the added fragment but without
      // the initialEvent firing. This is to prevent possible duplication of
      // events. A good example why this might occur is if the user had
      // unapproved transactions in memory when updating to the version that
      // includes this change. A migration would have also helped here but this
      // implementation hardens against other possible bugs where a fragment
      // does not exist.
      case TRANSACTION_EVENTS.APPROVED:
      case TRANSACTION_EVENTS.REJECTED:
        this.createEventFragment({
          category: 'Transactions',
          successEvent: TRANSACTION_EVENTS.APPROVED,
          failureEvent: TRANSACTION_EVENTS.REJECTED,
          properties,
          sensitiveProperties,
          persist: true,
          uniqueIdentifier,
        });
        break;
      // When a transaction is submitted it will always result in updating
      // to a finalized state (dropped, failed, confirmed) -- eventually.
      // However having a fragment started at this stage allows augmenting
      // analytics data with user interactions such as speeding up and
      // canceling the transactions. From this controllers perspective a new
      // transaction with a new id is generated for speed up and cancel
      // transactions, but from the UI we could augment the previous ID with
      // supplemental data to show user intent. Such as when they open the
      // cancel UI but don't submit. We can record that this happened and add
      // properties to the transaction event.
      case TRANSACTION_EVENTS.SUBMITTED:
        this.createEventFragment({
          category: 'Transactions',
          initialEvent: TRANSACTION_EVENTS.SUBMITTED,
          successEvent: TRANSACTION_EVENTS.FINALIZED,
          properties,
          sensitiveProperties,
          persist: true,
          uniqueIdentifier,
        });
        break;
      // If for some reason a transaction is finalized without the submitted
      // fragment existing in memory, we create the submitted fragment but
      // without the initialEvent firing. This is to prevent possible
      // duplication of events. A good example why this might occur is if th
      // user had pending transactions in memory when updating to the version
      // that includes this change. A migration would have also helped here but
      // this implementation hardens against other possible bugs where a
      // fragment does not exist.
      case TRANSACTION_EVENTS.FINALIZED:
        this.createEventFragment({
          category: 'Transactions',
          successEvent: TRANSACTION_EVENTS.FINALIZED,
          properties,
          sensitiveProperties,
          persist: true,
          uniqueIdentifier,
        });
        break;
      default:
        break;
    }
  }

  /**
   * Extracts relevant properties from a transaction meta
   * object and uses them to create and send metrics for various transaction
   * events.
   *
   * @param {Object} txMeta - the txMeta object
   * @param {TransactionMetaMetricsEventString} event - the name of the transaction event
   * @param {Object} extraParams - optional props and values to include in sensitiveProperties
   */
  async _trackTransactionMetricsEvent(txMeta, event, extraParams = {}) {
    if (!txMeta) {
      return;
    }
    const {
      properties,
      sensitiveProperties,
    } = await this._buildEventFragmentProperties(txMeta, extraParams);

    // Create event fragments for event types that spawn fragments, and ensure
    // existence of fragments for event types that act upon them.
    this._createTransactionEventFragment(
      txMeta,
      event,
      properties,
      sensitiveProperties,
    );

    let id;

    switch (event) {
      // If the user approves a transaction, finalize the transaction added
      // event fragment.
      case TRANSACTION_EVENTS.APPROVED:
        id = `transaction-added-${txMeta.id}`;
        this.updateEventFragment(id, { properties, sensitiveProperties });
        this.finalizeEventFragment(id);
        break;
      // If the user rejects a transaction, finalize the transaction added
      // event fragment. with the abandoned flag set.
      case TRANSACTION_EVENTS.REJECTED:
        id = `transaction-added-${txMeta.id}`;
        this.updateEventFragment(id, { properties, sensitiveProperties });
        this.finalizeEventFragment(id, {
          abandoned: true,
        });
        break;
      // When a transaction is finalized, also finalize the transaction
      // submitted event fragment.
      case TRANSACTION_EVENTS.FINALIZED:
        id = `transaction-submitted-${txMeta.id}`;
        this.updateEventFragment(id, { properties, sensitiveProperties });
        this.finalizeEventFragment(`transaction-submitted-${txMeta.id}`);
        break;
      default:
        break;
    }
  }

  _getTransactionCompletionTime(submittedTime) {
    return Math.round((Date.now() - submittedTime) / 1000).toString();
  }

  _getGasValuesInGWEI(gasParams) {
    const gasValuesInGwei = {};
    for (const param in gasParams) {
      if (isHexString(gasParams[param])) {
        gasValuesInGwei[param] = hexWEIToDecGWEI(gasParams[param]);
      } else {
        gasValuesInGwei[param] = gasParams[param];
      }
    }
    return gasValuesInGwei;
  }

  _failTransaction(txId, error) {
    this.txStateManager.setTxStatusFailed(txId, error);
    const txMeta = this.txStateManager.getTransaction(txId);
    this._trackTransactionMetricsEvent(txMeta, TRANSACTION_EVENTS.FINALIZED, {
      error: error.message,
    });
  }

  _dropTransaction(txId) {
    this.txStateManager.setTxStatusDropped(txId);
    const txMeta = this.txStateManager.getTransaction(txId);
    this._trackTransactionMetricsEvent(txMeta, TRANSACTION_EVENTS.FINALIZED);
  }
}

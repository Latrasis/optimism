import { expect } from '../setup'

/* External Imports */
import { ethers } from 'hardhat'
import '@nomiclabs/hardhat-ethers'
import { Signer, ContractFactory, Contract, BigNumber } from 'ethers'
import ganache from 'ganache-core'
import sinon from 'sinon'
import { Web3Provider } from '@ethersproject/providers'

import scc from '@eth-optimism/contracts/artifacts/contracts/optimistic-ethereum/OVM/chain/OVM_StateCommitmentChain.sol/OVM_StateCommitmentChain.json'
import { getContractInterface } from '@eth-optimism/contracts'
import { smockit, MockContract } from '@eth-optimism/smock'

/* Internal Imports */
import { MockchainProvider } from './mockchain-provider'
import {
  makeAddressManager,
  setProxyTarget,
  FORCE_INCLUSION_PERIOD_SECONDS,
  getContractFactory,
} from '../helpers'
import {
  CanonicalTransactionChainContract,
  TransactionBatchSubmitter as RealTransactionBatchSubmitter,
  StateBatchSubmitter,
  TX_BATCH_SUBMITTER_LOG_TAG,
  STATE_BATCH_SUBMITTER_LOG_TAG,
  BatchSubmitter,
} from '../../src'

import {
  QueueOrigin,
  Batch,
  Signature,
  TxType,
  remove0x,
} from '@eth-optimism/core-utils'
import { Logger, Metrics } from '@eth-optimism/common-ts'

const DECOMPRESSION_ADDRESS = '0x4200000000000000000000000000000000000008'
const DUMMY_ADDRESS = '0x' + '00'.repeat(20)
const EXAMPLE_STATE_ROOT =
  '0x16b7f83f409c7195b1f4fde5652f1b54a4477eacb6db7927691becafba5f8801'
const MAX_GAS_LIMIT = 8_000_000
const MAX_TX_SIZE = 100_000
const MIN_TX_SIZE = 1_000
const MIN_GAS_PRICE_IN_GWEI = 1
const MAX_GAS_PRICE_IN_GWEI = 70
const GAS_RETRY_INCREMENT = 5
const GAS_THRESHOLD_IN_GWEI = 120

// Helper functions
interface QueueElement {
  queueRoot: string
  timestamp: number
  blockNumber: number
}
const getQueueElement = async (
  ctcContract: Contract,
  nextQueueIndex?: number
): Promise<QueueElement> => {
  if (!nextQueueIndex) {
    nextQueueIndex = await ctcContract.getNextQueueIndex()
  }
  const nextQueueElement = await ctcContract.getQueueElement(nextQueueIndex)
  return nextQueueElement
}
const DUMMY_SIG: Signature = {
  r: '11'.repeat(32),
  s: '22'.repeat(32),
  v: 1,
}
// A transaction batch submitter which skips the validate batch check
class TransactionBatchSubmitter extends RealTransactionBatchSubmitter {
  protected async _validateBatch(batch: Batch): Promise<boolean> {
    return true
  }
}
const testMetrics = new Metrics({ prefix: 'bs_test' })

describe('BatchSubmitter', () => {
  let signer: Signer
  let sequencer: Signer
  before(async () => {
    ;[signer, sequencer] = await ethers.getSigners()
  })

  let AddressManager: Contract
  let Mock__OVM_ExecutionManager: MockContract
  let Mock__OVM_BondManager: MockContract
  let Mock__OVM_StateCommitmentChain: MockContract
  before(async () => {
    AddressManager = await makeAddressManager()
    await AddressManager.setAddress(
      'OVM_Sequencer',
      await sequencer.getAddress()
    )
    await AddressManager.setAddress(
      'OVM_DecompressionPrecompileAddress',
      DECOMPRESSION_ADDRESS
    )

    Mock__OVM_ExecutionManager = await smockit(
      await getContractFactory('OVM_ExecutionManager')
    )

    Mock__OVM_BondManager = await smockit(
      await getContractFactory('OVM_BondManager')
    )

    Mock__OVM_StateCommitmentChain = await smockit(
      await getContractFactory('OVM_StateCommitmentChain')
    )

    await setProxyTarget(
      AddressManager,
      'OVM_ExecutionManager',
      Mock__OVM_ExecutionManager
    )

    await setProxyTarget(
      AddressManager,
      'OVM_BondManager',
      Mock__OVM_BondManager
    )

    await setProxyTarget(
      AddressManager,
      'OVM_StateCommitmentChain',
      Mock__OVM_StateCommitmentChain
    )

    Mock__OVM_StateCommitmentChain.smocked.canOverwrite.will.return.with(false)
    Mock__OVM_ExecutionManager.smocked.getMaxTransactionGasLimit.will.return.with(
      MAX_GAS_LIMIT
    )
    Mock__OVM_BondManager.smocked.isCollateralized.will.return.with(true)
  })

  let Factory__OVM_CanonicalTransactionChain: ContractFactory
  let Factory__OVM_StateCommitmentChain: ContractFactory
  before(async () => {
    Factory__OVM_CanonicalTransactionChain = await getContractFactory(
      'OVM_CanonicalTransactionChain'
    )

    Factory__OVM_StateCommitmentChain = await getContractFactory(
      'OVM_StateCommitmentChain'
    )
  })

  let OVM_CanonicalTransactionChain: CanonicalTransactionChainContract
  let OVM_StateCommitmentChain: Contract
  let l2Provider: MockchainProvider
  beforeEach(async () => {
    const unwrapped_OVM_CanonicalTransactionChain = await Factory__OVM_CanonicalTransactionChain.deploy(
      AddressManager.address,
      FORCE_INCLUSION_PERIOD_SECONDS
    )
    await unwrapped_OVM_CanonicalTransactionChain.init()

    await AddressManager.setAddress(
      'OVM_CanonicalTransactionChain',
      unwrapped_OVM_CanonicalTransactionChain.address
    )

    OVM_CanonicalTransactionChain = new CanonicalTransactionChainContract(
      unwrapped_OVM_CanonicalTransactionChain.address,
      getContractInterface('OVM_CanonicalTransactionChain'),
      sequencer
    )

    const unwrapped_OVM_StateCommitmentChain = await Factory__OVM_StateCommitmentChain.deploy(
      AddressManager.address,
      0, // fraudProofWindowSeconds
      0 // sequencerPublishWindowSeconds
    )

    await unwrapped_OVM_StateCommitmentChain.init()

    await AddressManager.setAddress(
      'OVM_StateCommitmentChain',
      unwrapped_OVM_StateCommitmentChain.address
    )

    OVM_StateCommitmentChain = new Contract(
      unwrapped_OVM_StateCommitmentChain.address,
      getContractInterface('OVM_StateCommitmentChain'),
      sequencer
    )

    l2Provider = new MockchainProvider(
      OVM_CanonicalTransactionChain.address,
      OVM_StateCommitmentChain.address
    )
  })

  afterEach(() => {
    sinon.restore()
  })

  const createBatchSubmitter = (timeout: number): TransactionBatchSubmitter =>
    new TransactionBatchSubmitter(
      sequencer,
      l2Provider as any,
      MIN_TX_SIZE,
      MAX_TX_SIZE,
      10,
      timeout,
      1,
      100000,
      AddressManager.address,
      1,
      MIN_GAS_PRICE_IN_GWEI,
      MAX_GAS_PRICE_IN_GWEI,
      GAS_RETRY_INCREMENT,
      GAS_THRESHOLD_IN_GWEI,
      new Logger({ name: TX_BATCH_SUBMITTER_LOG_TAG }),
      testMetrics,
      false
    )

  describe('TransactionBatchSubmitter', () => {
    describe('submitNextBatch', () => {
      const enqueuedElements: Array<{
        blockNumber: number
        timestamp: number
      }> = []

      let batchSubmitter
      beforeEach(async () => {
        for (let i = 1; i < 15; i++) {
          await OVM_CanonicalTransactionChain.enqueue(
            '0x' + '01'.repeat(20),
            50_000,
            '0x' + i.toString().repeat(64),
            {
              gasLimit: 1_000_000,
            }
          )
        }
        batchSubmitter = createBatchSubmitter(0)
      })

      it('should submit a sequencer batch correctly', async () => {
        l2Provider.setNumBlocksToReturn(5)
        const nextQueueElement = await getQueueElement(
          OVM_CanonicalTransactionChain
        )
        l2Provider.setL2BlockData(
          {
            rawTransaction: '0x1234',
            l1BlockNumber: nextQueueElement.blockNumber - 1,
            txType: TxType.EIP155,
            queueOrigin: QueueOrigin.Sequencer,
            l1TxOrigin: null,
          } as any,
          nextQueueElement.timestamp - 1
        )
        let receipt = await batchSubmitter.submitNextBatch()
        let logData = remove0x(receipt.logs[1].data)
        expect(parseInt(logData.slice(64 * 0, 64 * 1), 16)).to.equal(0) // _startingQueueIndex
        expect(parseInt(logData.slice(64 * 1, 64 * 2), 16)).to.equal(0) // _numQueueElements
        expect(parseInt(logData.slice(64 * 2, 64 * 3), 16)).to.equal(6) // _totalElements
        receipt = await batchSubmitter.submitNextBatch()
        logData = remove0x(receipt.logs[1].data)
        expect(parseInt(logData.slice(64 * 0, 64 * 1), 16)).to.equal(0) // _startingQueueIndex
        expect(parseInt(logData.slice(64 * 1, 64 * 2), 16)).to.equal(0) // _numQueueElements
        expect(parseInt(logData.slice(64 * 2, 64 * 3), 16)).to.equal(11) // _totalElements
      })

      it('should submit a queue batch correctly', async () => {
        l2Provider.setNumBlocksToReturn(5)
        l2Provider.setL2BlockData({
          queueOrigin: QueueOrigin.L1ToL2,
        } as any)
        let receipt = await batchSubmitter.submitNextBatch()
        let logData = remove0x(receipt.logs[1].data)
        expect(parseInt(logData.slice(64 * 0, 64 * 1), 16)).to.equal(0) // _startingQueueIndex
        expect(parseInt(logData.slice(64 * 1, 64 * 2), 16)).to.equal(6) // _numQueueElements
        expect(parseInt(logData.slice(64 * 2, 64 * 3), 16)).to.equal(6) // _totalElements
        receipt = await batchSubmitter.submitNextBatch()
        logData = remove0x(receipt.logs[1].data)
        expect(parseInt(logData.slice(64 * 0, 64 * 1), 16)).to.equal(6) // _startingQueueIndex
        expect(parseInt(logData.slice(64 * 1, 64 * 2), 16)).to.equal(5) // _numQueueElements
        expect(parseInt(logData.slice(64 * 2, 64 * 3), 16)).to.equal(11) // _totalElements
      })

      it('should submit a batch with both queue and sequencer chain elements', async () => {
        l2Provider.setNumBlocksToReturn(10) // For this batch we'll return 10 elements!
        l2Provider.setL2BlockData({
          queueOrigin: QueueOrigin.L1ToL2,
        } as any)
        // Turn blocks 3-5 into sequencer txs
        const nextQueueElement = await getQueueElement(
          OVM_CanonicalTransactionChain,
          2
        )
        l2Provider.setL2BlockData(
          {
            rawTransaction: '0x1234',
            l1BlockNumber: nextQueueElement.blockNumber - 1,
            txType: TxType.EthSign,
            queueOrigin: QueueOrigin.Sequencer,
            l1TxOrigin: null,
          } as any,
          nextQueueElement.timestamp - 1,
          '', // blank stateRoot
          3,
          6
        )
        const receipt = await batchSubmitter.submitNextBatch()
        const logData = remove0x(receipt.logs[1].data)
        expect(parseInt(logData.slice(64 * 0, 64 * 1), 16)).to.equal(0) // _startingQueueIndex
        expect(parseInt(logData.slice(64 * 1, 64 * 2), 16)).to.equal(8) // _numQueueElements
        expect(parseInt(logData.slice(64 * 2, 64 * 3), 16)).to.equal(11) // _totalElements
      })

      it('should submit a small batch only after the timeout', async () => {
        l2Provider.setNumBlocksToReturn(2)
        l2Provider.setL2BlockData({
          queueOrigin: QueueOrigin.L1ToL2,
        } as any)

        // Create a batch submitter with a long timeout & make sure it doesn't submit the batches one after another
        const longTimeout = 10_000
        batchSubmitter = createBatchSubmitter(longTimeout)
        let receipt = await batchSubmitter.submitNextBatch()
        expect(receipt).to.not.be.undefined
        receipt = await batchSubmitter.submitNextBatch()
        // The receipt should be undefined because that means it didn't submit
        expect(receipt).to.be.undefined

        // This time create a batch submitter with a short timeout & it should submit batches after the timeout is reached
        const shortTimeout = 5
        batchSubmitter = createBatchSubmitter(shortTimeout)
        receipt = await batchSubmitter.submitNextBatch()
        expect(receipt).to.not.be.undefined
        // Sleep for the short timeout
        await new Promise((r) => setTimeout(r, shortTimeout))
        receipt = await batchSubmitter.submitNextBatch()
        // The receipt should NOT be undefined because that means it successfully submitted!
        expect(receipt).to.not.be.undefined
      })

      it('should not submit if gas price is over threshold', async () => {
        l2Provider.setNumBlocksToReturn(2)
        l2Provider.setL2BlockData({
          queueOrigin: QueueOrigin.L1ToL2,
        } as any)

        const highGasPriceWei = BigNumber.from(200).mul(1_000_000_000)

        sinon
          .stub(sequencer, 'getGasPrice')
          .callsFake(async () => highGasPriceWei)

        const receipt = await batchSubmitter.submitNextBatch()
        expect(sequencer.getGasPrice).to.have.been.calledOnce
        expect(receipt).to.be.undefined
      })

      it('should submit if gas price is not over threshold', async () => {
        l2Provider.setNumBlocksToReturn(2)
        l2Provider.setL2BlockData({
          queueOrigin: QueueOrigin.L1ToL2,
        } as any)

        const lowGasPriceWei = BigNumber.from(2).mul(1_000_000_000)

        sinon
          .stub(sequencer, 'getGasPrice')
          .callsFake(async () => lowGasPriceWei)

        const receipt = await batchSubmitter.submitNextBatch()
        expect(sequencer.getGasPrice).to.have.been.calledOnce
        expect(receipt).to.not.be.undefined
      })
    })
  })

  describe('StateBatchSubmitter', () => {
    let txBatchSubmitter
    let stateBatchSubmitter
    beforeEach(async () => {
      for (let i = 1; i < 15; i++) {
        await OVM_CanonicalTransactionChain.enqueue(
          '0x' + '01'.repeat(20),
          50_000,
          '0x' + i.toString().repeat(64),
          {
            gasLimit: 1_000_000,
          }
        )
      }

      txBatchSubmitter = createBatchSubmitter(0)

      l2Provider.setNumBlocksToReturn(5)
      const nextQueueElement = await getQueueElement(
        OVM_CanonicalTransactionChain
      )
      l2Provider.setL2BlockData(
        {
          rawTransaction: '0x1234',
          l1BlockNumber: nextQueueElement.blockNumber - 1,
          txType: TxType.EIP155,
          queueOrigin: QueueOrigin.Sequencer,
          l1TxOrigin: null,
        } as any,
        nextQueueElement.timestamp - 1,
        EXAMPLE_STATE_ROOT // example stateRoot
      )

      // submit a batch of transactions to enable state batch submission
      await txBatchSubmitter.submitNextBatch()

      stateBatchSubmitter = new StateBatchSubmitter(
        sequencer,
        l2Provider as any,
        MIN_TX_SIZE,
        MAX_TX_SIZE,
        10, // maxBatchSize
        0,
        1,
        100000,
        0, // finalityConfirmations
        AddressManager.address,
        1,
        MIN_GAS_PRICE_IN_GWEI,
        MAX_GAS_PRICE_IN_GWEI,
        GAS_RETRY_INCREMENT,
        GAS_THRESHOLD_IN_GWEI,
        new Logger({ name: STATE_BATCH_SUBMITTER_LOG_TAG }),
        testMetrics,
        '0x' + '01'.repeat(20) // placeholder for fraudSubmissionAddress
      )
    })

    describe('submitNextBatch', () => {
      it('should submit a state batch after a transaction batch', async () => {
        const receipt = await stateBatchSubmitter.submitNextBatch()
        expect(receipt).to.not.be.undefined

        const iface = new ethers.utils.Interface(scc.abi)
        const parsedLogs = iface.parseLog(receipt.logs[0])

        expect(parsedLogs.eventFragment.name).to.eq('StateBatchAppended')
        expect(parsedLogs.args._batchIndex.toNumber()).to.eq(0)
        expect(parsedLogs.args._batchSize.toNumber()).to.eq(6)
        expect(parsedLogs.args._prevTotalElements.toNumber()).to.eq(0)
      })
    })
  })
})

describe('Batch Submitter with Ganache', () => {
  let signer
  const server = ganache.server({
    default_balance_ether: 420,
    blockTime: 2_000,
  })
  const provider = new Web3Provider(ganache.provider())

  before(async () => {
    await server.listen(3001)
    signer = await provider.getSigner()
  })

  after(async () => {
    await server.close()
  })

  // Unit test for getReceiptWithResubmission function,
  // tests for increasing gas price on resubmission
  it('should resubmit a transaction if it is not confirmed', async () => {
    const gasPrices = []
    const numConfirmations = 2
    const sendTxFunc = async (gasPrice) => {
      // push the retried gasPrice
      gasPrices.push(gasPrice)

      const tx = signer.sendTransaction({
        to: DECOMPRESSION_ADDRESS,
        value: 88,
        nonce: 0,
        gasPrice,
      })

      const response = await tx

      return signer.provider.waitForTransaction(response.hash, numConfirmations)
    }

    const resubmissionConfig = {
      numConfirmations,
      resubmissionTimeout: 1_000, // retry every second
      minGasPriceInGwei: 0,
      maxGasPriceInGwei: 100,
      gasRetryIncrement: 5,
    }

    BatchSubmitter.getReceiptWithResubmission(
      sendTxFunc,
      resubmissionConfig,
      new Logger({ name: TX_BATCH_SUBMITTER_LOG_TAG })
    )

    // Wait 1.5s for at least 1 retry
    await new Promise((r) => setTimeout(r, 1500))

    // Iterate through gasPrices to ensure each entry increases from
    // the last
    const isIncreasing = gasPrices.reduce(
      (isInc, gasPrice, i, gP) =>
        (isInc && gasPrice > gP[i - 1]) || Number.NEGATIVE_INFINITY,
      true
    )

    expect(gasPrices).to.have.lengthOf.above(1) // retried at least once
    expect(isIncreasing).to.be.true
  })
})

import { Wallet, providers } from 'ethers'
import { MessageRelayerService } from '../service'
import SpreadSheet from '../spreadsheet'
import * as dotenv from 'dotenv'
import Config from 'bcfg'

interface Bcfg {
  load: (options: { env?: boolean; argv?: boolean }) => void
  str: (name: string, defaultValue?: string) => string
  uint: (name: string, defaultValue?: number) => number
  bool: (name: string, defaultValue?: boolean) => boolean
  ufloat: (name: string, defaultValue?: number) => number
}

dotenv.config()

const main = async () => {
  const config: Bcfg = new Config('message-relayer')
  config.load({
    env: true,
    argv: true,
  })

  const env = process.env
  const L2_NODE_WEB3_URL = config.str('l2-node-web3-url', env.L2_NODE_WEB3_URL)
  const L1_NODE_WEB3_URL = config.str('l1-node-web3-url', env.L1_NODE_WEB3_URL)
  const ADDRESS_MANAGER_ADDRESS = config.str(
    'address-manager-address',
    env.ADDRESS_MANAGER_ADDRESS
  )
  const L1_WALLET_KEY = config.str('l1-wallet-key', env.L1_WALLET_KEY)
  const MNEMONIC = config.str('mnemonic', env.MNEMONIC)
  const HD_PATH = config.str('hd-path', env.HD_PATH)
  const RELAY_GAS_LIMIT = config.uint(
    'relay-gas-limit',
    parseInt(env.RELAY_GAS_LIMIT, 10) || 4000000
  )
  const POLLING_INTERVAL = config.uint(
    'polling-interval',
    parseInt(env.POLLING_INTERVAL, 10) || 5000
  )
  const GET_LOGS_INTERVAL = config.uint(
    'get-logs-interval',
    parseInt(env.GET_LOGS_INTERVAL, 10) || 2000
  )
  const L2_BLOCK_OFFSET = config.uint(
    'l2-start-offset',
    parseInt(env.L2_BLOCK_OFFSET, 10) || 1
  )
  const L1_START_OFFSET = config.uint(
    'l1-start-offset',
    parseInt(env.L1_BLOCK_OFFSET, 10) || 1
  )
  const FROM_L2_TRANSACTION_INDEX = config.uint(
    'from-l2-transaction-index',
    parseInt(env.FROM_L2_TRANSACTION_INDEX, 10) || 0
  )

  // Spreadsheet configuration
  const SPREADSHEET_MODE = config.bool(
    'spreadsheet-mode',
    !!env.SPREADSHEET_MODE || false
  )
  const SHEET_ID = config.str('sheet-id', env.SHEET_ID)
  const CLIENT_EMAIL = config.str('client-email', env.CLIENT_EMAIL)
  const CLIENT_PRIVATE_KEY = config.str(
    'client-private-key',
    env.CLIENT_PRIVATE_KEY
  )

  if (!ADDRESS_MANAGER_ADDRESS) {
    throw new Error('Must pass ADDRESS_MANAGER_ADDRESS')
  }
  if (!L1_NODE_WEB3_URL) {
    throw new Error('Must pass L1_NODE_WEB3_URL')
  }
  if (!L2_NODE_WEB3_URL) {
    throw new Error('Must pass L2_NODE_WEB3_URL')
  }

  const l2Provider = new providers.JsonRpcProvider(L2_NODE_WEB3_URL)
  const l1Provider = new providers.JsonRpcProvider(L1_NODE_WEB3_URL)

  let wallet: Wallet
  if (L1_WALLET_KEY) {
    wallet = new Wallet(L1_WALLET_KEY, l1Provider)
  } else if (MNEMONIC) {
    wallet = Wallet.fromMnemonic(MNEMONIC, HD_PATH)
    wallet = wallet.connect(l1Provider)
  } else {
    throw new Error('Must pass one of L1_WALLET_KEY or MNEMONIC')
  }

  let spreadsheet = null
  if (SPREADSHEET_MODE) {
    if (!SHEET_ID) {
      throw new Error('Must pass SHEET_ID')
    }
    if (!CLIENT_EMAIL) {
      throw new Error('Must pass CLIENT_EMAIL')
    }
    if (!CLIENT_PRIVATE_KEY) {
      throw new Error('Must pass CLIENT_PRIVATE_KEY')
    }
    const privateKey = CLIENT_PRIVATE_KEY.replace(/\\n/g, '\n')
    spreadsheet = new SpreadSheet(SHEET_ID)
    await spreadsheet.init(CLIENT_EMAIL, privateKey)
  }

  const service = new MessageRelayerService({
    l1RpcProvider: l1Provider,
    l2RpcProvider: l2Provider,
    addressManagerAddress: ADDRESS_MANAGER_ADDRESS,
    l1Wallet: wallet,
    relayGasLimit: RELAY_GAS_LIMIT,
    fromL2TransactionIndex: FROM_L2_TRANSACTION_INDEX,
    pollingInterval: POLLING_INTERVAL,
    l2BlockOffset: L2_BLOCK_OFFSET,
    l1StartOffset: L1_START_OFFSET,
    getLogsInterval: GET_LOGS_INTERVAL,
    spreadsheetMode: !!SPREADSHEET_MODE,
    spreadsheet,
  })

  await service.start()
}
export default main

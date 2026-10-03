// Copied to frontend/src/lib/protocol.ts by scripts/sync-protocol.mjs.
export const PROTOCOL_REVISION = '7a917a8ec4dad72210351d80bcbf269073ac790d';
export const DECODER_VERSION = 2;
export const CURRENT_OPS = {
  0x2d:'T_LP_ADD', 0x2e:'T_LP_REMOVE', 0x2f:'T_SWAP_BATCH', 0x31:'T_PROTOCOL_FEE_CLAIM',
  0x32:'T_SWAP_VAR', 0x33:'T_SWAP_ROUTE', 0x34:'T_FARM_INIT', 0x35:'T_LP_BOND',
  0x36:'T_LP_UNBOND', 0x39:'T_CXFER_BOUND', 0x3b:'T_LP_HARVEST', 0x3c:'T_AXFER_BPP',
  0x3d:'T_AXFER_VAR_BPP', 0x3e:'T_FARM_REFUND', 0x5b:'T_PREAUTH_BID', 0x5c:'T_PREAUTH_BID_VAR',
  0x65:'T_CROSSOUT_MINT', 0x66:'T_CBTC_LOCK', 0x67:'T_CBTC_REDEEM',
  0x68:'T_BTC_CALL', 0x69:'T_ETH_CALL', 0x6c:'T_BTC_SHIELD', 0x6d:'T_BTC_SPEND', 0x6e:'T_BTC_AGG',
} as const;
export type ModernOpcode = (typeof CURRENT_OPS)[keyof typeof CURRENT_OPS] | 'T_POOL_BRIDGE_BURN';
export const TRANSFER_OPS = ['CXFER','T_CXFER_BPP','T_CXFER_BOUND','T_AXFER','T_AXFER_BPP',
  'T_AXFER_VAR','T_AXFER_VAR_BPP','T_PREAUTH_BID','T_PREAUTH_BID_VAR'];
export const RESERVED_OPS = new Set(['T_CBTC_TAC_DEPOSIT','T_CBTC_TAC_FORCE_CLOSE','T_CTAC_LIEN_SPLIT']);
export function protocolFamily(op: string): string {
  if (op.startsWith('T_BTC_S') || op === 'T_BTC_AGG') return 'bitcoin-pool';
  if (/^T_(LP_|FARM_)/.test(op)) return op === 'T_LP_ADD' || op === 'T_LP_REMOVE' ? 'amm' : 'farm';
  if (['T_CBTC_LOCK','T_CBTC_REDEEM'].includes(op)) return 'collateral';
  if (op.startsWith('T_SWAP_') || op === 'T_PROTOCOL_FEE_CLAIM') return 'amm';
  if (['T_POOL_BRIDGE_BURN','T_CROSSOUT_MINT','T_CBTC_LOCK','T_CBTC_REDEEM','T_BTC_CALL','T_ETH_CALL','T_CXFER_BOUND'].includes(op)) return 'bridge';
  if (/^T_(SLOT_|BRIDGE_|DROP|DCLAIM|WRAPPER|DEPOSIT|WITHDRAW)/.test(op) || RESERVED_OPS.has(op)) return 'legacy';
  return 'bitcoin';
}
export function supportStatus(op: string): 'current' | 'legacy' | 'reserved' | 'experimental' | 'unverified-extension' {
  if (RESERVED_OPS.has(op)) return 'reserved';
  if (op === 'T_BTC_AGG') return 'unverified-extension';
  if (protocolFamily(op) === 'bitcoin-pool') return 'experimental';
  if (protocolFamily(op) === 'legacy' || ['T_AXFER_VAR','T_AXFER_VAR_BPP'].includes(op)) return 'legacy';
  return 'current';
}
export function jsonSafe(value: unknown): any {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return Array.from(value, b => b.toString(16).padStart(2,'0')).join('');
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'payload').map(([k,v]) => [k,jsonSafe(v)]));
  return value;
}

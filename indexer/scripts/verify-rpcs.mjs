// Read-only provider checks. URLs and provider error text are never printed.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { keccak256, toHex } from 'viem';

const env = parseEnv(readFileSync(new URL('../../.env', import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('../src/vendor/deployments.json', import.meta.url), 'utf8'));
const results = [];
const hex = value => '0x' + value.toString(16);
const selector = name => keccak256(toHex(name)).slice(0, 10);
async function verify(chain, name, key) {
  const checks = [];
  const url = env[key] || env[`EVM_RPC_URL_${chain}`];
  async function rpc(method, params = []) {
    let response;
    try {
      response = await fetch(url, { method: 'POST', headers: {'content-type':'application/json'},
        body: JSON.stringify({jsonrpc:'2.0', id:1, method, params}), signal:AbortSignal.timeout(20_000) });
    } catch (e) { throw new Error(e.name === 'TimeoutError' ? 'request timeout' : 'network unavailable'); }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error(`JSON-RPC error ${Number(data.error.code)}`);
    if (data.result == null) throw new Error('missing result');
    return data.result;
  }
  async function check(label, fn) {
    try { const detail = await fn(); checks.push({name:label,ready:true,detail:detail || 'passed'}); }
    catch (e) { checks.push({name:label,ready:false,detail:e.message}); }
    console.log(`${name}: ${label}: ${checks.at(-1).ready ? 'PASS' : 'FAIL'} (${checks.at(-1).detail})`);
  }
  if (!url) { checks.push({name:'configuration',ready:false,detail:`missing ${key}`}); return {chain,name,checks}; }
  const contracts = manifest.contracts.filter(c => c.chainId === chain);
  const start = Math.min(...contracts.map(c => c.startBlock));
  let tip;
  await check('chain identity', async () => {
    if (Number(BigInt(await rpc('eth_chainId'))) !== chain) throw new Error('wrong chain');
    tip = Number(BigInt(await rpc('eth_blockNumber')));
    if (tip < start + 12) throw new Error('provider behind deployment');
    return `chain ${chain}, tip ${tip}`;
  });
  if (!tip) return {chain,name,checks};
  const pool = contracts.find(c => c.name === (chain === 1 ? 'ConfidentialPool' : 'TacitEvmPool'));
  const safe = tip - 12;
  let deployedAt = start;
  await check('current deployment code', async () => {
    const missing = [];
    for (const c of contracts) {
      const code = await rpc('eth_getCode', [c.address, hex(safe)]);
      if (code === '0x') missing.push(c.name);
    }
    if (missing.length) throw new Error(`missing contract code: ${missing.join(', ')}`);
    return `${contracts.length} deployments present`;
  });
  await check('historical block and deployment code', async () => {
    const block = await rpc('eth_getBlockByNumber', [hex(start), false]);
    if (Number(BigInt(block.number)) !== start || !/^0x[0-9a-f]{64}$/i.test(block.hash)) throw new Error('invalid block');
    const code = await rpc('eth_getCode', [pool.address, hex(start)]);
    if (code === '0x') {
      // The manifest's scan start may precede this contract's actual creation.
      // Verify archive reads on both sides of the first code-bearing block.
      let low=start, high=safe;
      if (await rpc('eth_getCode',[pool.address,hex(high)]) === '0x') throw new Error('deployment code missing');
      while (high-low>1) {
        const middle=Math.floor((low+high)/2);
        if (await rpc('eth_getCode',[pool.address,hex(middle)]) === '0x') low=middle;
        else high=middle;
      }
      deployedAt=high;
      return `scan start ${start} precedes pool creation ${deployedAt}`;
    }
    if (!/^0x[0-9a-f]+$/i.test(code)) throw new Error('invalid code');
    return `block ${start}`;
  });
  await check('historical logs, production window and address filter', async () => {
    const logs = await rpc('eth_getLogs', [{fromBlock:hex(start),toBlock:hex(Math.min(start+127,safe)),address:contracts.map(c=>c.address)}]);
    if (!Array.isArray(logs) || logs.some(l=>!l.blockHash || !l.transactionHash || l.removed)) throw new Error('invalid logs');
    return `${logs.length} logs`;
  });
  for (const height of [deployedAt, safe]) await check(`contract reads at ${height}`, async () => {
    const method = chain === 1 ? 'nextLeafIndex()' : 'rootSize(bytes32)';
      const root = chain === 1 ? '' : await rpc('eth_call', [{to:pool.address,data:selector('root()')},hex(height)]);
      const result = await rpc('eth_call', [{to:pool.address,data:selector(method)+root.replace(/^0x/,'')},hex(height)]);
      if (!/^0x[0-9a-f]{64}$/i.test(result)) throw new Error('invalid getter result');
    return method;
  });
  if (chain === 1) {
    await check('historical storage', async () => {
      const value = await rpc('eth_getStorageAt',[pool.address,'0x54',hex(start)]);
      if (!/^0x[0-9a-f]{64}$/i.test(value)) throw new Error('invalid storage');
    });
    const token = contracts.find(c => c.name === 'WrappedTac');
    if (token) await check('opening supply before watched range', async () => {
      const value = await rpc('eth_call',[{to:token.address,data:selector('totalSupply()')},hex(token.startBlock-1)]);
      // Empty code before constructor is a valid zero opening supply.
      if (value !== '0x' && !/^0x[0-9a-f]{64}$/i.test(value)) throw new Error('invalid supply');
    });
    for (const height of [start,safe]) await check(`complete callTracer block ${height}`, async () => {
      const block = await rpc('eth_getBlockByNumber',[hex(height),false]);
      const traces = await rpc('debug_traceBlockByNumber',[hex(height),{tracer:'callTracer',timeout:'15s'}]);
      if (!Array.isArray(traces) || traces.length !== block.transactions.length) throw new Error('incomplete block trace');
      for (let i=0;i<traces.length;i++) {
        const t=traces[i];
        if (t.error || !t.result || !['CALL','CREATE','CREATE2'].includes(t.result.type) || (t.txHash && t.txHash !== block.transactions[i])) throw new Error('incompatible trace response');
      }
      if (block.transactions.length) {
        const txid=block.transactions[0];
        const tx=await rpc('eth_getTransactionByHash',[txid]);
        const trace=await rpc('debug_traceTransaction',[txid,{tracer:'callTracer',timeout:'15s'}]);
        if (trace.input !== tx.input || (tx.to && trace.to?.toLowerCase() !== tx.to.toLowerCase())) throw new Error('incompatible transaction trace');
      }
      return `${traces.length} transaction traces`;
    });
  }
  return {chain,name,start,deployedAt,safe,checks};
}
for (const args of [[1,'Ethereum','RPC_ETH'],[8453,'Base','RPC_BASE'],[4663,'Robinhood','RPC_ROBINHOOD']]) results.push(await verify(...args));
const report={checkedAt:new Date().toISOString(),revision:manifest.revision,ready:results.every(r=>r.checks.every(c=>c.ready)),results};
writeFileSync('/tmp/tacitscan-rpc-verification.json',JSON.stringify(report,null,2)+'\n');
console.log(`RPC capability gate: ${report.ready ? 'PASS' : 'FAIL'}`);
process.exitCode=report.ready?0:1;

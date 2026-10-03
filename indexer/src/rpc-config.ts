// Accept the deployment names used by the operator, preserving explicit overrides.
for (const [chain, alias] of [[1, 'RPC_ETH'], [8453, 'RPC_BASE'], [4663, 'RPC_ROBINHOOD']] as const) {
  if (!process.env[`EVM_RPC_URL_${chain}`] && process.env[alias]) {
    process.env[`EVM_RPC_URL_${chain}`] = process.env[alias];
  }
}

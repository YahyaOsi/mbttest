export const SOLANA_MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

export function isSolanaMainnet(genesisHash: string): boolean {
  return genesisHash === SOLANA_MAINNET_GENESIS;
}

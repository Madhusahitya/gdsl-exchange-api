/** BSC mainnet — PancakeSwap V2 uses the same router interface as Uniswap V2 */
export const BSC_CHAIN_ID = 56

export const PANCAKE_V2_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E' as const
export const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955' as const
export const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' as const

export const SWAP_PATH_BUY = [USDT_BSC, WBNB] as const
export const SWAP_PATH_SELL = [WBNB, USDT_BSC] as const

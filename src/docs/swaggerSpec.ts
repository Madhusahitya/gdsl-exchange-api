/**
 * OpenAPI 3.0.3 Specification for Godslandx / koie.fin Trading API
 */
export const swaggerSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Godslandx / koie.fin Trading API',
    version: '1.0.0',
    description: `
High-concurrency trading backend for Godslandx / koie.fin.
Supports decentralized swaps (Jupiter, PancakeSwap, 1inch), CEX algorithmic trading, real-time WebSocket streams, multi-agent AI execution, and portfolio management.

### Authentication
Most endpoints require authentication via **Bearer Token**:
\`\`\`http
Authorization: Bearer <your_jwt_access_token>
\`\`\`
Alternatively, session cookies (\`cf_token\`) are supported for web clients.
    `,
    contact: {
      name: 'Godslandx Engineering',
      url: 'https://trade.godslandx.com',
    },
  },
  servers: [
    {
      url: 'http://localhost:8000',
      description: 'Local Development Server',
    },
    {
      url: 'https://api.godslandx.com',
      description: 'Production Droplet Gateway',
    },
  ],
  tags: [
    { name: 'System & Health', description: 'Uptime, health checks, and metrics' },
    { name: 'Authentication', description: 'User login, registration, OTP email verification, and session management' },
    { name: 'Dashboard', description: 'High-performance Redis-cached metrics, equity tracking, and performance' },
    { name: 'Portfolio & Wallets', description: 'Custodial & non-custodial wallet balances and equity distribution' },
    { name: 'DEX Jupiter (Solana)', description: 'Solana swaps, quotes, open position tracking, and take-profit/stop-loss' },
    { name: 'DEX 1inch & Cross-Chain', description: 'Multi-chain DEX aggregation quotes and swaps' },
    { name: 'Trading & Orders', description: 'Order book operations, limit orders, and execution history' },
    { name: 'Bots & AI Automation', description: 'Algorithmic trading strategies and Super Machine AI agents' },
    { name: 'Deposits & Withdrawals', description: 'On-chain deposit addresses, withdrawals, and fiat onramp' },
  ],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Provide your JWT access token (obtained from /api/auth/login)',
      },
      CookieAuth: {
        type: 'apiKey',
        in: 'cookie',
        name: 'cf_token',
        description: 'Browser session cookie authentication',
      },
    },
    schemas: {
      ErrorResponse: {
        type: 'object',
        properties: {
          error: { type: 'string', example: 'Invalid credentials or expired token' },
          code: { type: 'string', example: 'AUTH_FAILED' },
        },
        required: ['error'],
      },
      HealthResponse: {
        type: 'object',
        properties: {
          status: { type: 'string', example: 'healthy' },
          timestamp: { type: 'string', format: 'date-time' },
          uptime: { type: 'number', example: 1245.8 },
          db: { type: 'string', example: 'connected' },
        },
      },
      User: {
        type: 'object',
        properties: {
          id: { type: 'string', example: 'usr_c99e7698' },
          email: { type: 'string', format: 'email', example: 'trader@godslandx.com' },
          emailVerified: { type: 'boolean', example: true },
          referralCode: { type: 'string', example: 'A7F92B' },
          trialBalance: { type: 'number', example: 1000 },
          role: { type: 'string', example: 'USER' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      AuthResponse: {
        type: 'object',
        properties: {
          token: { type: 'string', example: 'eyJhbGciOiJIUzI1NiIsIn...' },
          refreshToken: { type: 'string', example: 'eyJhbGciOiJIUzI1NiIsIn...' },
          user: { $ref: '#/components/schemas/User' },
        },
      },
      LoginRequest: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email', example: 'trader@godslandx.com' },
          password: { type: 'string', format: 'password', example: 'Secret123!' },
        },
      },
      RegisterRequest: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email', example: 'newuser@godslandx.com' },
          password: { type: 'string', format: 'password', example: 'SuperSecure123!' },
          referralCode: { type: 'string', example: 'A7F92B' },
        },
      },
      VerifyEmailRequest: {
        type: 'object',
        required: ['email', 'code'],
        properties: {
          email: { type: 'string', format: 'email', example: 'newuser@godslandx.com' },
          code: { type: 'string', example: '123456', description: '6-digit OTP received via email' },
        },
      },
      DashboardSummary: {
        type: 'object',
        properties: {
          email: { type: 'string', example: 'trader@godslandx.com' },
          referralCode: { type: 'string', example: 'A7F92B' },
          walletBalance: { type: 'number', example: 12450.75 },
          walletChangePercent: { type: 'number', example: 4.82 },
          walletChangeUsd: { type: 'number', example: 572.4 },
          cashEquity: { type: 'number', example: 8200.0 },
          equitySource: { type: 'string', enum: ['ledger', 'personal_wallet_live', 'browser_wallet_live'], example: 'ledger' },
          todayProfit: { type: 'number', example: 284.15 },
          weekProfit: { type: 'number', example: 1420.5 },
          totalProfit: { type: 'number', example: 5820.0 },
          unrealizedPnl: { type: 'number', example: 88.5 },
          tradesToday: { type: 'integer', example: 14 },
          winsToday: { type: 'integer', example: 11 },
          lossesToday: { type: 'integer', example: 3 },
          winRateToday: { type: 'number', example: 78.57 },
          activePlans: { type: 'integer', example: 1 },
          bot: {
            type: 'object',
            properties: {
              label: { type: 'string', example: 'Binance Super Scalper' },
              hashRateLabel: { type: 'string', example: '42.5 Gh/s' },
              changePercent: { type: 'number', example: 3.2 },
            },
          },
        },
      },
      JupiterQuote: {
        type: 'object',
        properties: {
          inputMint: { type: 'string', example: 'So11111111111111111111111111111111111111112' },
          inAmount: { type: 'string', example: '1000000000' },
          outputMint: { type: 'string', example: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
          outAmount: { type: 'string', example: '145250000' },
          priceImpactPct: { type: 'number', example: 0.05 },
          routePlan: { type: 'array', items: { type: 'object' } },
        },
      },
      JupiterSwapRequest: {
        type: 'object',
        required: ['inputMint', 'outputMint', 'amount'],
        properties: {
          inputMint: { type: 'string', example: 'So11111111111111111111111111111111111111112' },
          outputMint: { type: 'string', example: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
          amount: { type: 'string', example: '1000000000' },
          slippageBps: { type: 'number', example: 50 },
          takeProfitPct: { type: 'number', example: 15 },
          stopLossPct: { type: 'number', example: 5 },
        },
      },
      OrderRequest: {
        type: 'object',
        required: ['pair', 'side', 'type', 'amount'],
        properties: {
          pair: { type: 'string', example: 'BTC/USDT' },
          side: { type: 'string', enum: ['BUY', 'SELL'], example: 'BUY' },
          type: { type: 'string', enum: ['MARKET', 'LIMIT'], example: 'LIMIT' },
          price: { type: 'number', example: 64250.0 },
          amount: { type: 'number', example: 0.05 },
        },
      },
    },
  },
  security: [
    { BearerAuth: [] },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['System & Health'],
        summary: 'API & Database Health Check',
        description: 'Checks database connectivity and server uptime.',
        security: [],
        responses: {
          200: {
            description: 'System healthy and database connected',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/HealthResponse' } } },
          },
          503: {
            description: 'Database disconnected or server unhealthy',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/HealthResponse' } } },
          },
        },
      },
    },
    '/health/live-automation': {
      get: {
        tags: ['System & Health'],
        summary: 'Live Automation Operational Status',
        description: 'Returns whether live automated trading is currently active or undergoing maintenance.',
        security: [],
        responses: {
          200: { description: 'Live automation is active and ready' },
          503: { description: 'Maintenance mode active' },
        },
      },
    },
    '/metrics': {
      get: {
        tags: ['System & Health'],
        summary: 'Prometheus Metrics',
        description: 'Prometheus metrics endpoint. Requires METRICS_BEARER_TOKEN in production.',
        responses: {
          200: { description: 'Plaintext Prometheus metrics', content: { 'text/plain': {} } },
          401: { description: 'Unauthorized' },
        },
      },
    },
    '/api/auth/config': {
      get: {
        tags: ['Authentication'],
        summary: 'Public Application Configuration',
        description: 'Returns public settings such as registration open/closed status.',
        security: [],
        responses: {
          200: {
            description: 'Public app configuration',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    registrationOpen: { type: 'boolean', example: true },
                    appName: { type: 'string', example: 'koie.fin' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/auth/register': {
      post: {
        tags: ['Authentication'],
        summary: 'Register New User',
        description: 'Creates a new user account and sends a 6-digit verification code to the provided email.',
        security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/RegisterRequest' } } },
        },
        responses: {
          200: {
            description: 'Account created, OTP sent to email',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    message: { type: 'string', example: 'Verification code sent to your email.' },
                    userId: { type: 'string', example: 'usr_c99e7698' },
                  },
                },
              },
            },
          },
          400: { description: 'Validation error or email already exists', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          403: { description: 'Registration currently invite-only' },
        },
      },
    },
    '/api/auth/verify-email': {
      post: {
        tags: ['Authentication'],
        summary: 'Verify Email with OTP',
        description: 'Validates the 6-digit verification code and issues authentication tokens.',
        security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/VerifyEmailRequest' } } },
        },
        responses: {
          200: {
            description: 'Email verified successfully',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthResponse' } } },
          },
          400: { description: 'Invalid or expired OTP code' },
        },
      },
    },
    '/api/auth/resend-otp': {
      post: {
        tags: ['Authentication'],
        summary: 'Resend Verification Code',
        description: 'Resends a fresh 6-digit verification code to the registered email.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email'],
                properties: { email: { type: 'string', format: 'email', example: 'user@godslandx.com' } },
              },
            },
          },
        },
        responses: {
          200: { description: 'Verification code resent' },
          429: { description: 'Cooldown period active — please wait before requesting another code' },
        },
      },
    },
    '/api/auth/login': {
      post: {
        tags: ['Authentication'],
        summary: 'Log in',
        description: 'Authenticates user with email and password. Returns access JWT and sets secure session cookies.',
        security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginRequest' } } },
        },
        responses: {
          200: {
            description: 'Login successful',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthResponse' } } },
          },
          401: { description: 'Invalid email or password' },
          403: { description: 'Email unverified — OTP sent to verify' },
        },
      },
    },
    '/api/auth/refresh': {
      post: {
        tags: ['Authentication'],
        summary: 'Refresh Access Token',
        description: 'Rotates the refresh token and returns a fresh access JWT.',
        security: [],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { refreshToken: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Token refreshed successfully',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthResponse' } } },
          },
          401: { description: 'Invalid or expired refresh token' },
        },
      },
    },
    '/api/auth/logout': {
      post: {
        tags: ['Authentication'],
        summary: 'Log Out',
        description: 'Invalidates the refresh session and clears authentication cookies.',
        responses: {
          200: { description: 'Logged out successfully' },
        },
      },
    },
    '/api/auth/me': {
      get: {
        tags: ['Authentication'],
        summary: 'Get Current Authenticated User',
        description: 'Returns profile and balance info for the authenticated user.',
        responses: {
          200: {
            description: 'Current user profile',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
          },
          401: { description: 'Unauthorized' },
        },
      },
    },
    '/api/dashboard/summary': {
      get: {
        tags: ['Dashboard'],
        summary: 'Aggregated Dashboard Summary',
        description: `
Returns comprehensive overview metrics:
- Real-time wallet balance and 24h change
- Ledger equity vs live on-chain balances
- Today's win rate, profit, and trade count
- Active bot status and hash rate
- Referral rewards and active plans

**Performance Note:** Results are cached in Redis RAM for 8 seconds to support 100,000+ concurrent requests.
        `,
        parameters: [
          {
            in: 'query',
            name: 'b_tot',
            schema: { type: 'number' },
            description: 'Optional browser wallet total USD balance (for non-custodial UI mode)',
          },
        ],
        responses: {
          200: {
            description: 'Dashboard metrics',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DashboardSummary' } } },
          },
          401: { description: 'Unauthorized' },
        },
      },
    },
    '/api/portfolio': {
      get: {
        tags: ['Portfolio & Wallets'],
        summary: 'Portfolio Equity & Asset Holdings',
        description: 'Returns total equity, realized and unrealized PnL, and individual coin balances.',
        responses: {
          200: {
            description: 'Portfolio holdings and equity',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    totalEquity: { type: 'number', example: 12450.75 },
                    realizedPnl: { type: 'number', example: 5820.0 },
                    unrealizedPnl: { type: 'number', example: 88.5 },
                    balances: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          asset: { type: 'string', example: 'USDT' },
                          free: { type: 'number', example: 5000.0 },
                          locked: { type: 'number', example: 200.0 },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          401: { description: 'Unauthorized' },
        },
      },
    },
    '/api/wallet/balances': {
      get: {
        tags: ['Portfolio & Wallets'],
        summary: 'Custodial Wallet Asset Balances',
        description: 'Lists all custodial balances currently held in the user account.',
        responses: {
          200: { description: 'List of balances' },
          401: { description: 'Unauthorized' },
        },
      },
    },
    '/api/dex-jupiter/quote': {
      get: {
        tags: ['DEX Jupiter (Solana)'],
        summary: 'Get Jupiter Swap Quote',
        description: 'Queries Jupiter DEX routing engine for the optimal Solana token swap route and price impact.',
        parameters: [
          { in: 'query', name: 'inputMint', required: true, schema: { type: 'string' }, example: 'So11111111111111111111111111111111111111112' },
          { in: 'query', name: 'outputMint', required: true, schema: { type: 'string' }, example: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
          { in: 'query', name: 'amount', required: true, schema: { type: 'string' }, example: '1000000000' },
          { in: 'query', name: 'slippageBps', schema: { type: 'integer', default: 50 } },
        ],
        responses: {
          200: {
            description: 'Quote details',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/JupiterQuote' } } },
          },
          400: { description: 'Invalid token mint or amount' },
          502: { description: 'Solana RPC or Jupiter API unavailable' },
        },
      },
    },
    '/api/dex-jupiter/swap': {
      post: {
        tags: ['DEX Jupiter (Solana)'],
        summary: 'Execute Jupiter Swap',
        description: 'Signs and broadcasts a Solana swap transaction on-chain. Optionally configures automated TP/SL position monitoring.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/JupiterSwapRequest' } } },
        },
        responses: {
          200: {
            description: 'Swap executed successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    txid: { type: 'string', example: '5UBpA5...solanaTxHash' },
                    positionId: { type: 'string', example: 'jup_pos_8372' },
                  },
                },
              },
            },
          },
          400: { description: 'Insufficient balance or slippage exceeded' },
        },
      },
    },
    '/api/dex-jupiter/open-positions': {
      get: {
        tags: ['DEX Jupiter (Solana)'],
        summary: 'List Tracked Open Positions',
        description: 'Returns active Solana positions monitored by the Trading Engine with live PnL and TP/SL thresholds.',
        responses: {
          200: { description: 'Active tracked open positions' },
          401: { description: 'Unauthorized' },
        },
      },
    },
    '/api/dex-jupiter/wallet/summary': {
      get: {
        tags: ['DEX Jupiter (Solana)'],
        summary: 'Solana Hot/Custodial Wallet Summary',
        description: 'Returns SOL and SPL token balances. Uses cached fallback if Solana RPC is under heavy load.',
        responses: {
          200: { description: 'Solana wallet balance summary' },
        },
      },
    },
    '/api/dex-1inch/quote': {
      get: {
        tags: ['DEX 1inch & Cross-Chain'],
        summary: '1inch Multi-Chain Swap Quote',
        description: 'Calculates the best route across EVM chains (Ethereum, BSC, Arbitrum, Polygon).',
        parameters: [
          { in: 'query', name: 'chainId', required: true, schema: { type: 'integer', default: 56 } },
          { in: 'query', name: 'src', required: true, schema: { type: 'string' } },
          { in: 'query', name: 'dst', required: true, schema: { type: 'string' } },
          { in: 'query', name: 'amount', required: true, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: '1inch quote' },
        },
      },
    },
    '/api/orders': {
      get: {
        tags: ['Trading & Orders'],
        summary: 'List Orders',
        description: 'Retrieves user order history with optional filtering by status and pair.',
        parameters: [
          { in: 'query', name: 'pair', schema: { type: 'string' } },
          { in: 'query', name: 'status', schema: { type: 'string', enum: ['OPEN', 'FILLED', 'CANCELED'] } },
        ],
        responses: {
          200: { description: 'List of orders' },
        },
      },
      post: {
        tags: ['Trading & Orders'],
        summary: 'Create New Order',
        description: 'Submits a new market or limit order to the trading engine.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderRequest' } } },
        },
        responses: {
          201: { description: 'Order created' },
          400: { description: 'Invalid order parameters' },
        },
      },
    },
    '/api/trades': {
      get: {
        tags: ['Trading & Orders'],
        summary: 'Trade Execution History',
        description: 'Returns completed trades, execution prices, and realized profits.',
        parameters: [
          { in: 'query', name: 'limit', schema: { type: 'integer', default: 50 } },
        ],
        responses: {
          200: { description: 'Historical trades' },
        },
      },
    },
    '/api/strategies': {
      get: {
        tags: ['Bots & AI Automation'],
        summary: 'Strategies Catalog',
        description: 'Returns available algorithmic trading strategies (e.g. Scalping, Momentum, Trend Follower).',
        responses: {
          200: { description: 'Strategy definitions and risk tiers' },
        },
      },
    },
    '/api/bot/status': {
      get: {
        tags: ['Bots & AI Automation'],
        summary: 'Active Bot Session Status',
        description: 'Returns active bot parameters, simulated hash rate, and session run time.',
        responses: {
          200: { description: 'Bot session status' },
        },
      },
    },
    '/api/bot/start': {
      post: {
        tags: ['Bots & AI Automation'],
        summary: 'Start Trading Bot',
        description: 'Launches automated trading bot for the user with the specified strategy and capital allocation.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['strategyId'],
                properties: {
                  strategyId: { type: 'string', example: 'strat_scalper_01' },
                  allocationUsd: { type: 'number', example: 500.0 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Bot started successfully' },
          400: { description: 'Insufficient funds or active session already running' },
        },
      },
    },
    '/api/bot/stop': {
      post: {
        tags: ['Bots & AI Automation'],
        summary: 'Stop Trading Bot',
        description: 'Terminates running bot session and liquidates or retains open positions according to preference.',
        responses: {
          200: { description: 'Bot stopped successfully' },
        },
      },
    },
    '/api/deposit/address': {
      get: {
        tags: ['Deposits & Withdrawals'],
        summary: 'Get Deposit Address',
        description: 'Returns user custodial deposit address for the requested blockchain network.',
        parameters: [
          { in: 'query', name: 'chain', required: true, schema: { type: 'string', enum: ['ethereum', 'bsc', 'solana', 'bitcoin'] } },
        ],
        responses: {
          200: {
            description: 'Deposit address details',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    address: { type: 'string', example: '0x71C...4389' },
                    chain: { type: 'string', example: 'bsc' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/withdraw/request': {
      post: {
        tags: ['Deposits & Withdrawals'],
        summary: 'Submit Withdrawal Request',
        description: 'Requests withdrawal of funds to an external blockchain address. Requires 2FA or email confirmation.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['asset', 'amount', 'destinationAddress'],
                properties: {
                  asset: { type: 'string', example: 'USDT' },
                  amount: { type: 'number', example: 250.0 },
                  destinationAddress: { type: 'string', example: '0x71C...4389' },
                  chain: { type: 'string', example: 'bsc' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Withdrawal submitted for processing' },
          400: { description: 'Insufficient balance or invalid destination address' },
        },
      },
    },
  },
}

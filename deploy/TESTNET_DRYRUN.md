# Hyperliquid Testnet Dry Run — Part A (execution-code validation)

Validates that the live-execution code works against real Hyperliquid **testnet** infrastructure, at ZERO financial risk, before any mainnet/live trading.

## What you (the user) must do
1. Go to **app.hyperliquid-testnet.xyz**, connect a wallet, and **generate an API wallet** (Settings → API).
2. Fund the testnet account from the **testnet faucet** (free play USDC).
3. Place the testnet keys on the server YOURSELF (never paste a key in chat). From your terminal, using the `! ` prefix:
   ```
   ! ssh root@2.29.18.207 'printf "HL_API_WALLET_PRIVATE_KEY=0xYOUR_TESTNET_API_KEY\nHL_ACCOUNT_ADDRESS=0xYOUR_ACCOUNT_ADDRESS\n" >> /opt/trading-agent/data/secrets.env && chmod 600 /opt/trading-agent/data/secrets.env'
   ```

## Then Claude runs (safe, testnet-only, self-cleaning)
- Temporarily set `mode: testnet` in server config (rule engine + LLM stay paper; only this validation touches the venue).
- `docker exec deploy-agent-1 python -m agent.testnet_validate`
- The script REFUSES to run unless mode==testnet, uses tiny sizes, places an unfilled resting limit, queries status, cancels it, runs housekeeping — and reports pass/fail per venue op.

## Gate to proceed
- All checks ✅ → manual market-order+stop+close test → then Part B (wire the rule engine to place real orders) → then live SMALL (2% risk).
- Any ❌ → fix before touching real money.

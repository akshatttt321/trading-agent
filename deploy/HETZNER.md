# Hetzner server setup (≈ 10 minutes, ≈ €4/month)

## 1. Create the server (Hetzner Cloud Console → your project)

1. **Security → SSH Keys → Add SSH key.** Paste the contents of your public key:
   `cat ~/.ssh/id_rsa.pub` — name it `macbook`.
2. **Servers → Add Server**
   - Location: **Falkenstein** or **Helsinki** (EU IP: Hyperliquid + Polymarket both reachable; US locations are blocked by both venues — do not pick Ashburn/Hillsboro)
   - Image: **Ubuntu 24.04**
   - Type: **Shared vCPU → x86 → CX22** (2 vCPU / 4 GB / 40 GB) — plenty
   - Networking: IPv4 ✔ (needed), IPv6 ✔
   - SSH key: select `macbook`
   - Firewall: create one now (step 2) or add later
   - Name: `trading-agent`
   - **Create & Buy now**
3. Copy the **IPv4 address** from the server page. Call it `IP` below.

## 2. Firewall (Hetzner Console → Firewalls → Create)

Inbound rules — that's all the box needs:

| protocol | port | source | why |
|---|---|---|---|
| TCP | 22 | your IP (or 0.0.0.0/0 if it changes) | SSH |
| TCP | 80 | 0.0.0.0/0, ::/0 | Let's Encrypt challenge |
| TCP | 443 | 0.0.0.0/0, ::/0 | dashboard API over HTTPS |

Apply it to the `trading-agent` server. No outbound rules needed (Hetzner allows all outbound by default).

## 3. First login (from your Mac)

```bash
ssh root@IP           # accept the fingerprint
apt update && apt -y upgrade && timedatectl set-ntp true && exit
```

## 4. Fill `.env` locally (`~/trading-agent/.env`)

```
ANTHROPIC_API_KEY=sk-ant-...                 # console.anthropic.com
DASHBOARD_TOKEN=<output of: openssl rand -hex 24>
DASHBOARD_HOST=A-B-C-D.sslip.io              # your IP with dashes, e.g. 65-21-10-200.sslip.io
DASHBOARD_ORIGIN=https://akshat43121.github.io
```
`sslip.io` is a free public DNS trick: `65-21-10-200.sslip.io` always resolves to `65.21.10.200`, and
Let's Encrypt happily issues a certificate for it, so you get HTTPS without buying a domain.
Leave the wallet keys empty for now — first deployment is **paper mode**.

## 5. Deploy

```bash
cd ~/trading-agent
./deploy/remote_deploy.sh root@IP
```
The script installs Docker, syncs the code, runs the preflight *on the server* (API key, Hyperliquid,
Polymarket reachability from that IP, clock, kill switch) and starts the three containers only if
everything passes. It ends by printing the dashboard API URL and the log/kill commands.

## 6. Point the dashboard at it

Open the GitHub Pages UI → gear icon → API base URL `https://A-B-C-D.sslip.io`, token = `DASHBOARD_TOKEN`
→ **Test connection**. Within one cycle (5 min) the equity curve starts.

## Day-to-day

```bash
ssh root@IP 'cd /opt/trading-agent && docker compose -f deploy/docker-compose.yml logs -f --tail 100 agent'
ssh root@IP 'cd /opt/trading-agent && docker compose -f deploy/docker-compose.yml run --rm agent python scripts/status.py'
ssh root@IP 'touch /opt/trading-agent/data/KILL'        # emergency stop (or the dashboard's KILL button)
```
Config changes: edit `config.yaml` locally, re-run `./deploy/remote_deploy.sh root@IP` (it restarts the agent).

## Going live later

Same box, three edits in `.env` (Hyperliquid **API wallet** key + account address, Polymarket burner key
+ funder, `LIVE_TRADING_ACK=...`), `mode: live` in `config.yaml`, redeploy. Preflight then also verifies
the accounts are funded before the agent starts.

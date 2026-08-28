#!/usr/bin/env bash
# Publish the ui/ folder to GitHub Pages as a standalone public repo (free hosting).
#   ./ui/deploy_pages.sh            # first run creates the repo + enables Pages; later runs just push
# Requires: gh (logged in), git. Nothing secret lives in ui/ - the API token is entered in the browser.
set -euo pipefail
REPO="${REPO:-trading-agent-ui}"
UI="$(cd "$(dirname "$0")" && pwd)"
USER="$(gh api user -q .login)"
WORK="$(mktemp -d)"

cp "$UI"/index.html "$UI"/*.js "$UI"/*.css "$WORK"/ 2>/dev/null
cp "$UI"/API.md "$UI"/API_ADMIN.md "$WORK"/ 2>/dev/null || true
# cache-bust: stamp script/style refs so browsers pick up new deploys without a hard refresh
V="$(date -u +%Y%m%d%H%M%S)"
sed -i '' -e "s/src=\"app.js\"/src=\"app.js?v=$V\"/" -e "s/src=\"mock.js\"/src=\"mock.js?v=$V\"/" \
    -e "s/href=\"style.css\"/href=\"style.css?v=$V\"/" "$WORK/index.html" 2>/dev/null \
  || sed -i -e "s/src=\"app.js\"/src=\"app.js?v=$V\"/" -e "s/src=\"mock.js\"/src=\"mock.js?v=$V\"/" \
    -e "s/href=\"style.css\"/href=\"style.css?v=$V\"/" "$WORK/index.html"
touch "$WORK/.nojekyll"
cd "$WORK"
git init -q -b main
git add -A
git -c user.name="$USER" -c user.email="$USER@users.noreply.github.com" commit -qm "dashboard $(date -u +%Y-%m-%dT%H:%MZ)"

if ! gh repo view "$USER/$REPO" >/dev/null 2>&1; then
  echo "==> creating public repo $USER/$REPO"
  gh repo create "$REPO" --public --description "Trading agent dashboard (static, GitHub Pages)" >/dev/null
fi
git remote add origin "https://github.com/$USER/$REPO.git"
echo "==> pushing"
git push -q -f origin main

echo "==> enabling GitHub Pages (main branch, root)"
gh api -X POST "repos/$USER/$REPO/pages" -f 'source[branch]=main' -f 'source[path]=/' >/dev/null 2>&1 \
  || gh api -X PUT "repos/$USER/$REPO/pages" -f 'source[branch]=main' -f 'source[path]=/' >/dev/null 2>&1 || true

URL="https://$(echo "$USER" | tr '[:upper:]' '[:lower:]').github.io/$REPO/"
echo
echo "dashboard URL: $URL   (first publish takes ~1 minute)"
echo "set DASHBOARD_ORIGIN=https://$(echo "$USER" | tr '[:upper:]' '[:lower:]').github.io in .env (already the default)"
rm -rf "$WORK"

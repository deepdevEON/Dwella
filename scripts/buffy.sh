#!/bin/bash
# buffy.sh — Helper script for Buffy (Freebuff AI) to talk to Dwella.
#
# Usage:
#   bash scripts/buffy.sh message <type> <content> [symbol]
#     Send a message to display in Dwella. Types: chat, analysis, signal, alert
#     Example: bash scripts/buffy.sh message analysis "NQ showing bearish divergence on M15" NQ
#
#   bash scripts/buffy.sh signal <symbol> <action> <confidence> <reasoning> [entry] [stop] [target] [timeframe]
#     Send a trade signal. Actions: buy, sell, close, hold
#     Example: bash scripts/buffy.sh signal NQ buy 0.82 "Strong OB displacement on M5, bullish MSS confirmed" 18642 18580 18850 M5
#
#   bash scripts/buffy.sh markets
#     Get current market quotes from the MT5 bridge
#
#   bash scripts/buffy.sh positions
#     Get open positions from the MT5 bridge
#
#   bash scripts/buffy.sh status
#     Check if Buffy API is running and get system status
#
#   bash scripts/buffy.sh health
#     Quick health check

API="http://127.0.0.1:8645"
BBAPI="http://127.0.0.1:8646"
CMD="${1:-help}"

case "$CMD" in
  message)
    TYPE="${2:-chat}"
    CONTENT="${3:-}"
    SYMBOL="${4:-}"
    if [ -z "$CONTENT" ]; then
      echo "Usage: buffy.sh message <type> <content> [symbol]"
      echo "  Types: chat, analysis, signal, alert"
      exit 1
    fi
    BODY="{\"type\":\"$TYPE\",\"content\":$(echo "$CONTENT" | jq -Rs .)}"
    [ -n "$SYMBOL" ] && BODY="{\"type\":\"$TYPE\",\"content\":$(echo "$CONTENT" | jq -Rs .),\"symbol\":\"$SYMBOL\"}"
    curl -s -X POST "$API/buffy/message" \
      -H "Content-Type: application/json" \
      -d "$BODY" | jq .
    ;;
  signal)
    SYMBOL="${2:-}"
    ACTION="${3:-hold}"
    CONFIDENCE="${4:-0}"
    REASONING="${5:-}"
    ENTRY="${6:-null}"
    STOP="${7:-null}"
    TARGET="${8:-null}"
    TF="${9:-}"
    if [ -z "$SYMBOL" ] || [ -z "$REASONING" ]; then
      echo "Usage: buffy.sh signal <symbol> <action> <confidence> <reasoning> [entry] [stop] [target] [timeframe]"
      exit 1
    fi
    BODY="{\"symbol\":\"$SYMBOL\",\"action\":\"$ACTION\",\"confidence\":$CONFIDENCE,\"reasoning\":$(echo "$REASONING" | jq -Rs .),\"entry\":$ENTRY,\"stop\":$STOP,\"target\":$TARGET,\"timeframe\":\"$TF\"}"
    curl -s -X POST "$API/buffy/signal" \
      -H "Content-Type: application/json" \
      -d "$BODY" | jq .
    ;;
  markets)
    curl -s "$API/buffy/markets" | jq .
    ;;
  positions)
    curl -s "$API/buffy/positions" | jq .
    ;;
  status)
    curl -s "$API/buffy/status" | jq .
    ;;
  health)
    curl -s "$API/health" | jq .
    ;;
  messages)
    LIMIT="${2:-20}"
    curl -s "$API/buffy/messages?limit=$LIMIT" | jq .
    ;;
  signals)
    curl -s "$API/buffy/signals" | jq .
    ;;
  # ── Browserbase Trader commands ──────────────────────────────────────
  browser-start)
    curl -s -X POST "$BBAPI/browser/start" | jq .
    ;;
  browser-navigate)
    URL="${2:-}"
    [ -z "$URL" ] && echo "Usage: buffy.sh browser-navigate <url>" && exit 1
    curl -s -X POST "$BBAPI/browser/navigate" -H "Content-Type: application/json" -d "{\"url\":\"$URL\"}" | jq .
    ;;
  browser-click)
    SEL="${2:-}"
    [ -z "$SEL" ] && echo "Usage: buffy.sh browser-click <css-selector>" && exit 1
    curl -s -X POST "$BBAPI/browser/click" -H "Content-Type: application/json" -d "{\"selector\":\"$SEL\"}" | jq .
    ;;
  browser-type)
    SEL="${2:-}"; TEXT="${3:-}"
    [ -z "$SEL" ] && echo "Usage: buffy.sh browser-type <selector> <text>" && exit 1
    curl -s -X POST "$BBAPI/browser/type" -H "Content-Type: application/json" -d "{\"selector\":\"$SEL\",\"text\":$(echo "$TEXT" | jq -Rs .)}" | jq .
    ;;
  browser-ss)
    curl -s -X POST "$BBAPI/browser/screenshot" | jq '.ok, .size' 2>/dev/null || curl -s -X POST "$BBAPI/browser/screenshot" | jq .
    ;;
  browser-eval)
    CODE="${2:-}"
    [ -z "$CODE" ] && echo "Usage: buffy.sh browser-eval <javascript-code>" && exit 1
    curl -s -X POST "$BBAPI/browser/evaluate" -H "Content-Type: application/json" -d "{\"code\":$(echo "$CODE" | jq -Rs .)}" | jq .
    ;;
  browser-stop)
    curl -s -X POST "$BBAPI/browser/stop" | jq .
    ;;
  browser-status)
    curl -s "$BBAPI/browser/status" | jq .
    ;;
  # ── End Browserbase ──────────────────────────────────────────────────

  help|*)
    echo "Buffy + Browserbase — Talk to Dwella from Freebuff"
    echo ""
    echo "=== Buffy API (Dwella integration)"
    echo "  message <type> <content> [symbol]   Send a message (chat|analysis|signal|alert)"
    echo "  signal <sym> <action> <conf> <reasoning> [entry] [stop] [target] [tf]"
    echo "  markets                               Get market quotes via MT5"
    echo "  positions                             Get open positions via MT5"
    echo "  status                                System + connection status"
    echo "  health                                Quick health check"
    echo "  messages [limit]                      View message history"
    echo "  signals                               View recent signals"
    echo ""
    echo "=== Browserbase Trader (Cloud browser for manual trading)"
    echo "  browser-start                         Create/get persistent browser session"
    echo "  browser-navigate <url>                Navigate to URL"
    echo "  browser-click <selector>              Click element"
    echo "  browser-type <selector> <text>        Type text into element"
    echo "  browser-ss                            Take screenshot"
    echo "  browser-eval <code>                   Run JavaScript in page"
    echo "  browser-stop                          End session"
    echo "  browser-status                        Session status"
    echo ""
    echo "Examples:"
    echo "  bash scripts/buffy.sh message analysis \"NQ looking strong on M5\" NQ"
    echo "  bash scripts/buffy.sh signal NQ buy 0.85 \"Bullish OB + MSS\" 18642 18580 18850 M5"
    echo "  bash scripts/buffy.sh browser-start"
    echo "  bash scripts/buffy.sh browser-navigate https://trader.tradovate.com"
    echo "  bash scripts/buffy.sh browser-click \".buy-button\""
    ;;
esac

#!/bin/bash

# Claudia - Stop Script
# Kills the server process listening on port 4001

PORT=4001
PIDS=$(lsof -ti:$PORT 2>/dev/null)

if [ -z "$PIDS" ]; then
    echo "No process found on port $PORT"
    exit 0
fi

kill $PIDS 2>/dev/null
echo "Stopped Claudia (port $PORT)"

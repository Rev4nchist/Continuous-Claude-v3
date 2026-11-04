#!/bin/bash
x=1
helper() {
  echo "in helper"
}
if [ "$x" = "2" ]; then
  echo never
fi
helper
bash /app/sub.sh

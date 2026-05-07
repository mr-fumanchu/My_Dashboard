#!/bin/bash
cd "$(dirname "$0")"
git add -A
git commit -m "Update $(date '+%Y-%m-%d %H:%M')"
git push

#!/bin/bash

# Simple script to package the extension for distribution

echo "📦 Packaging AliExpress Coupon Claimer..."

# Remove any existing package
rm -f AliClaimer.zip

# Create zip excluding unnecessary files
zip -r AliClaimer.zip . \
  -x "*.git*" \
  -x "*.DS_Store" \
  -x "package.sh" \
  -x "PRODUCTION_CHECKLIST.md" \
  -x "*.md" \
  -x "node_modules/*" \
  -x "*.log"

echo "✅ Package created: AliClaimer.zip"
echo ""
echo "To install:"
echo "1. Go to chrome://extensions/"
echo "2. Enable Developer Mode"
echo "3. Drag and drop AliClaimer.zip"
echo ""
echo "Or extract and 'Load unpacked' the folder"

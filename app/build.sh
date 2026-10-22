#!/bin/sh
# Builds "Claude Session Monitor.app" into build/ and, with --install, copies it to
# ~/Applications. Needs only the Xcode command line tools (swiftc), no Xcode.
#
#   sh app/build.sh            build
#   sh app/build.sh --install  build and install

set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
NAME="Claude Session Monitor"
APP="build/$NAME.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# Universal: one build for Apple silicon and one for Intel, joined with lipo.
for arch in arm64 x86_64; do
  swiftc -O -swift-version 5 -target "$arch-apple-macos14.0" \
    -framework AppKit -framework WebKit -framework ServiceManagement \
    app/main.swift -o "build/ClaudeSessionMonitor-$arch"
done
lipo -create build/ClaudeSessionMonitor-arm64 build/ClaudeSessionMonitor-x86_64 \
  -output "$APP/Contents/MacOS/ClaudeSessionMonitor"

sed "s|__PROJECT_PATH__|$ROOT|" app/Info.plist > "$APP/Contents/Info.plist"

# Icon: draw once at 1024 px, then let sips and iconutil make the sizes.
if [ ! -f build/AppIcon.icns ] || [ app/make-icon.swift -nt build/AppIcon.icns ]; then
  swift app/make-icon.swift build/icon-1024.png >/dev/null
  rm -rf build/AppIcon.iconset && mkdir -p build/AppIcon.iconset
  for s in 16 32 128 256 512; do
    sips -z $s $s build/icon-1024.png --out "build/AppIcon.iconset/icon_${s}x${s}.png" >/dev/null
    d=$((s * 2))
    sips -z $d $d build/icon-1024.png --out "build/AppIcon.iconset/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns build/AppIcon.iconset -o build/AppIcon.icns
fi
cp build/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

# Ad-hoc signature: enough for this Mac, and for macOS to accept it as a login item.
codesign --force --sign - "$APP" >/dev/null
echo "Built $APP"

if [ "$1" = "--install" ]; then
  DEST="$HOME/Applications/$NAME.app"
  # Quit the running copy and wait until it is really gone; opening it again too
  # soon fails while macOS still has the old one registered.
  osascript -e "tell application \"$NAME\" to quit" >/dev/null 2>&1 || true
  i=0
  while pgrep -f 'ClaudeSessionMonitor$' >/dev/null && [ $i -lt 40 ]; do sleep 0.25; i=$((i + 1)); done
  sleep 1
  rm -rf "$DEST"
  ditto "$APP" "$DEST"
  echo "Installed $DEST"
  # Reopen it, so installing never leaves it closed.
  i=0
  until open "$DEST" 2>/dev/null || [ $i -ge 5 ]; do sleep 1; i=$((i + 1)); done
  echo "Opened $NAME"
fi

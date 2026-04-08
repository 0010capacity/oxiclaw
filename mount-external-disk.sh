#!/bin/bash
# External Disk Auto-Mount for SSH
# Run this on your local Mac terminal

set -e

DISK_NAME="SATECHI DISK"
MOUNT_POINT="/Volumes/$DISK_NAME"

echo "=== External Disk Auto-Mount Setup ==="

# Check if disk exists
if [ ! -d "$MOUNT_POINT" ]; then
    echo "Error: $MOUNT_POINT not found"
    exit 1
fi

# Get Volume UUID
UUID=$(diskutil info "$MOUNT_POINT" | grep "Volume UUID" | awk '{print $3}')
echo "Volume UUID: $UUID"

# Create LaunchAgent
AGENT_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$AGENT_DIR"

PLIST="$AGENT_DIR/com.user.external-disk-mount.plist"

cat > "$PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.user.external-disk-mount</string>
    <key>RunAtLoad</key>
    <true/>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>diskutil unmount "$MOUNT_POINT" && diskutil mount -mountPoint "$MOUNT_POINT" /dev/disk7s1</string>
    </array>
</dict>
</plist>
EOF

echo "Created: $PLIST"

# Load LaunchAgent
launchctl load "$PLIST"
echo "LaunchAgent loaded"

# Mount now (unmount first, then remount)
diskutil unmount "$MOUNT_POINT" 2>/dev/null || true
diskutil mount -mountPoint "$MOUNT_POINT" /dev/disk7s1
echo "Mounted: $MOUNT_POINT"

# Verify
echo ""
echo "=== Verification ==="
mount | grep "$DISK_NAME"
ls -la "$MOUNT_POINT" | head -5

echo ""
echo "Done! SSH sessions will now have access to external disk."
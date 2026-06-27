#!/bin/bash
DIR="$(cd "$(dirname "$0")/../../" && pwd)"
source "$DIR/config.sh"


# Get current time and day
CURRENT_HOUR=$(date +%H)
CURRENT_MINUTE=$(date +%M)
CURRENT_DAY=$(date +%u)  # 4 = Thursday

# Exit immediately if it is 5:00 to 5:10
if { [ "$CURRENT_HOUR" -eq 4 ] && [ "$CURRENT_MINUTE" -ge 55 ]; } || \
   { [ "$CURRENT_HOUR" -eq 5 ] && [ "$CURRENT_MINUTE" -le 10 ]; }; then
   $SAYDATE "ServerChecker: paused from 0445-0510..." >> $LOGS && exit 0
fi

# Exit if it is Thursday 13:55 to 14:15
if [ "$CURRENT_DAY" -eq 4 ] && (
   ([ "$CURRENT_HOUR" -eq 13 ] && [ "$CURRENT_MINUTE" -ge 55 ]) ||
   ([ "$CURRENT_HOUR" -eq 14 ] && [ "$CURRENT_MINUTE" -le 15 ])
); then
   $SAYDATE "ServerChecker: paused Thursday 13:55-14:15..." >> $LOGS && exit 0
fi

# Check if RustDedicated is running
if pgrep -x "RustDedicated" > /dev/null
then
    echo "$(date)" "ServerChecker: Rust Server  is running." >> "$LOGS"
    echo -e "\e[1;32m$(cat $DIR/Files/Images/Online)\e[0m" > $DIR/Files/Images/Status
else
    # If RustDedicated is not running, run the test script
    echo "$(date)" "ServerChecker: Rust not running. Attempting restart" >> "$LOGS"
    $USER $SERVER start
    echo -e "\e[1;31m$(cat $DIR/Files/Images/Offline)\e[0m" > $DIR/Files/Images/Status
    # Wait for 5 seconds
    sleep 5

    # Check again if RustDedicated is running after 5 seconds
    if pgrep -x "RustDedicated" > /dev/null
    then
        echo "$(date)" "ServerChecker: Rust Server is now running." >> "$LOGS"
        echo -e "\e[1;32m$(cat $DIR/Files/Images/Online)\e[0m" > $DIR/Files/Images/Status
    else
        echo -e "\e[1;31m$(cat $DIR/Files/Images/Offline)\e[0m" > $DIR/Files/Images/Status
        discord_url="$DISCORDURL"

generate_post_data() {
  cat <<EOF
{
  "content": ":warning: SERVER IS OFFLINE",
  "embeds": [{
    "title": "SERVER IS OFFLINE AND NEEDS ATTENTION!!",
    "description": "Server is offline and has failed to restart. Attention is needed!",
    "color": "11086"
  }]
}
EOF
}


# POST request to Discord Webhook / Disabling for now to stop the spamming of the discord server 
curl -H "Content-Type: application/json" -X POST -d "$(generate_post_data)" $discord_url
    fi
fi

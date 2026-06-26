#!/bin/bash
DIR="$(cd "$(dirname "$0")/../../" && pwd)"
source "$DIR/config.sh"

#########################################################################################
##					FULL-WIPE				       ##
## Fullwipe will stop server, Wipe all player and map data. Then copy new config files ##
## Make sure that wipeconfigutaor has been ran and configured before running Fullwipe. ##
##				   BY: ALIENATEDMAMMAL 				       ##
##										       ##
#########################################################################################
discord_url="$DISCORDURL"

generate_post_data() {
  cat <<EOF
{
  "content": ":warning: SERVER IS ABOUT TO WIPE!!!!!",
  "embeds": [{
    "title": "SERVER IS WIPING NOW!!",
    "description": "Server wipe is now in progress. We will be back soon!!!",
    "color": "11086"
  }]
}
EOF
}


# POST request to Discord Webhook / Disabling for now to stop the spamming of the discord server
curl -H "Content-Type: application/json" -X POST -d "$(generate_post_data)" $discord_url



# Stops Server
	$SAYDATE $SCRIPTFULL $SERVERNAME Server will now stop.... >> $LOGS
 $USER $SERVER stop >> $LOGS
	$SAYDATE $SCRIPTFULL $SERVERNAME Server Has Stopped >> $LOGS
	$SAYDATE $SCRIPTFULL $SERVERNAME Server will now start Full Wipe.... >> $LOGS

# Removing players BP's
 rm -fr /home/$USERNAME/serverfiles/server/$HOSTNAME/player.blueprints.* >> $LOGS
	$SAYDATE $SCRIPTFULL $SERVERNAME Player Blueprints has been removed >> $LOGS

# Removing players Identities
 rm -fr /home/$USERNAME/serverfiles/server/$HOSTNAME/player.identities.* >> $LOGS
	$SAYDATE $SCRIPTFULL $SERVERNAME Player Blueprints has been removed >> $LOGS

# Removing players states
 rm -fr /home/$USERNAME/serverfiles/server/$HOSTNAME/player.states.* >> $LOGS
	$SAYDATE $SCRIPTFULL $SERVERNAME Player Blueprints has been removed >> $LOGS

# Removing players Deaths
 rm -fr /home/$USERNAME/serverfiles/server/$HOSTNAME/player.deaths.* >> $LOGS
	$SAYDATE $SCRIPTFULL $SERVERNAME Player Blueprints has been removed >> $LOGS

# Removing Player Relationshp
 rm -fr /home/$USERNAME/serverfiles/server/$HOSTNAME/relationship* >> $LOGS
 	$SAYDATE $SCRIPTFULL $SERVERNAME Relationships removed >> $LOGS

# Removing old map data to clear up space.
 rm -fr /home/$USERNAME/serverfiles/server/$HOSTNAME/proceduralmap* >> $LOGS
	$SAYDATE $SCRIPTFULL $SERVERNAME Map Data has been removed >> $LOGS

# Removing common files
 rm -fr /home/$USERNAME/lgsm/config-lgsm/rustserver/common.cfg
	$SAYDATE $SCRIPTFULL $SERVERNAME Removed old common.cfg >> $LOGS

# Removing rustserver files
 rm -fr /home/$USERNAME/lgsm/config-lgsm/rustserver/rustserver.cfg
	$SAYDATE $SCRIPTFULL $SERVERNAME Removed old rustserver.cfg >> $LOGS

# Removing SmartChatbot files
 rm -fr /home/$USERNAME/serverfiles/oxide/config/SmartChatBot.json
	$SAYDATE $SCRIPTFULL $SERVERNAME  Removed old SmartChatBot.json >> $LOGS

# Copying common files
 cp /home/$USERNAME/AMAP/Files/Config/common.cfg /home/$USERNAME/lgsm/config-lgsm/rustserver/
        $SAYDATE $SCRIPTFULL $SERVERNAME New common.cfg file installed >> $LOGS

# Copying config files
 cp /home/$USERNAME/AMAP/Files/Config/config.cfg /home/$USERNAME/lgsm/config-lgsm/rustserver/
	$SAYDATE $SCRIPTFULL $SERVERNAME New config.cfg file installed >> $LOGS

# Copying Rustserver files
 cp /home/$USERNAME/AMAP/Files/Config/rustserver.cfg /home/$USERNAME/lgsm/config-lgsm/rustserver/
	$SAYDATE $SCRIPTFULL $SERVERNAME New rustserver.cfg installed >> $LOGS

# Copying Smartbot Files
 cp /home/$USERNAME/AMAP/Files/Config/SmartChatBot.json /home/$USERNAME/serverfiles/oxide/config/
	$SAYDATE $SCRIPTFULL $SERVERNAME  New SmartChatBot.json installed >> $LOGS

# Starting Server
 $SERVERSTART

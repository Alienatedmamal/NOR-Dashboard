#!/bin/bash
DIR="$(cd "$(dirname "$0")/../../" && pwd)"
source "$DIR/config.sh"

# This creates server backups usings sync. 
$SAYDATE $SCRIPTBACKUPS starting >> $LOGS
$SAYDATE $SCRIPTBACKUPS Backing up Oxide Files.... >> $LOGS
	$SYNC /home/$USERNAME/serverfiles/oxide /home/$USERNAME/LIVE_FILES/ || $SAYDATE $SCRIPTBACKUPS Failed to Backup Oxide >> $LOGS
$SAYDATE $SCRIPTBACKUPS Oxide Files Have Been Backed Up >> $LOGS
$SAYDATE $SCRIPTBACKUPS Backing up NoobsOnTheRun.... >> $LOGS
	$SYNC /home/$USERNAME/serverfiles/server/$HOSTNAME /home/$USERNAME/LIVE_FILES/ || $SAYDATE $SCRIPTBACKUPS Failed to Backup NoobsOnTheRn >> $LOGS
$SAYDATE $SCRIPTBACKUPS $HOSTNAME Files Have Been Backed Up >> $LOGS
$SAYDATE $SCRIPTBACKUPS Backing up LGSM Files.... >> $LOGS
	$SYNC /home/$USERNAME/lgsm /home/$USERNAME/LIVE_FILES/ || $SAYDATE $SCRIPTBACKUPS Faled to Backup LGSM >> $LOGS
$SAYDATE $SCRIPTBACKUPS lgsm Files Have Been Backed Up >> $LOGS
$SAYDATE $SCRIPTBACKUPS Backing up RustDedicated_Data....>> $LOGS
#	 Currently should not need this since we can just download the discord dll from umods. 
#	 $SYNC /home/$USERNAME/serverfiles/RustDedicated_Data/ /home/$USERNAME/LIVE_FILES/ || $SAYDATE $SCRIPTBACKUPS Failed To Backup RustDedicated_Data >> $LOGS
# $SAYDATE $SCRIPTBACKUPS RustDedicated Files Have Been Backed Up >> $LOGS
$SAYDATE $SCRIPTBACKUPS Server Back Up Have Been Completed >> $LOGS


#######################################################################################################################################
#                                                                                                                                     #
#                                       Created on 6-22-26    By: Alienatedmammal                                                     #
#       This below is added to create and add backups to a timed stamp folder. This is to help with roll backs of server.             #
#                                                                                                                                     #
#######################################################################################################################################

$SAYDATE ServerBackups: Roll back files backing up >> $LOGS

# Determines the date/time to label folder:
$SAYDATE ServerBackups: Folder name created... >> $LOGS
folddate="$(date +%Y-%m-%d_%H-%M-%S)"

# Makes folder with current date/time:
$SAYDATE ServerBackups: Directory created: $folddate  >> $LOGS
mkdir -p "/home/$USERNAME/BackUps/$folddate"

# Copying ServerBackup files to Server Backups
$SAYDATE ServerBackups: Copying Files....... >> $LOGS
cp -r /home/$USERNAME/LIVE_FILES/* /home/$USERNAME/BackUps/$folddate

$SAYDATE ServerBackups: Roll back files copied and backed up... >> $LOGS
	$SYNC /home/$USERNAME/lgsm/config-lgsm/rustserver /home/$USERNAME/LIVE_FILES/

########################################################################################################################################
#                                                                                                                                      #
#						 This part removes files older than 24 hrs                                             #
#																       #
########################################################################################################################################

target_dir="/home/$USERNAME/BackUps/"
$SAYDATE "ServerBackups: Removing files older than 24hrs" >> $LOGS
total=$(find "$target_dir" -mindepth 1 -maxdepth 1 -type d | wc -l)
old=$(find "$target_dir" -mindepth 1 -maxdepth 1 -type d -mmin +1440 | wc -l)
mem=$(du -sh "$target_dir")

find "$target_dir" \
    -mindepth 1 \
    -maxdepth 1 \
    -type d \
    -mmin +1440 \
    -exec rm -rf {} +

kept=$((total - old))

$SAYDATE "ServerBackups: File Storage :   $mem" >> $LOGS
$SAYDATE "ServerBackups: Directories total:   $total" >> $LOGS
$SAYDATE "ServerBackups: Directories removed: $old" >> $LOGS
$SAYDATE "ServerBackups: Directories kept:    $kept" >> $LOGS


$SAYDATE $SCRIPTBACKUPS Syncing to remote server... >> $LOGS
$SYNC /home/$USERNAME/BackUps/ webserver@10.0.55.6:/home/webserver/RustBackups >> $LOGS
$SAYDATE $SCRIPTBACKUPS Syncing to remote server completed >> $LOGS

$SAYDATE $SCRIPTBACKUPS rustserver Files Have Been Backed Up >> $LOGS || $SAYDATE $SCRIPTBACKUPS Failed To Backup rustserver >> $LOGS
$SAYDATE $SCRIPTBACKUPS ServerBackup Has Finished >> $LOGS  

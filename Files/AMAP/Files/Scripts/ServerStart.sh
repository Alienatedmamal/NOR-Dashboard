#!/bin/bash
DIR="$(cd "$(dirname "$0")/../../" && pwd)"
source "$DIR/config.sh"
# =================================================

# Defined libary
log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" | tee -a "$LOGS"
}

error() {
    log "ERROR: $1"
    echo "=== Check the log: $LOGS ==="
    exit 1
}

# Checks if LGSM script exists and is executable
if [ ! -f "$LGSM_SCRIPT" ]; then
    error "LGSM script not found at: $LGSM_SCRIPT"
fi

if [ ! -x "$LGSM_SCRIPT" ]; then
    error "LGSM script is not executable. Run: chmod +x $LGSM_SCRIPT"
fi

# Changes directory where rustserver is located
cd "$(dirname "$LGSM_SCRIPT")" || error "Cannot cd to server directory"

log "=== Starting Rust LGSM Maintenance Cycle ==="
log "Working directory: $(pwd)"
log "LGSM script: $LGSM_SCRIPT"

# Runs LGSM command with error checks
run_lgsm() {
    local cmd="$1"
    log "Running: $cmd"

    # Run and capture output with exit code
    if ! output=$("$LGSM_SCRIPT" $cmd 2>&1); then
        log "FAILED: $cmd"
        log "Output: $output"
        return 1
    else
        log "SUCCESS: $cmd"
        # Logs first few lines to avoid huge output
        echo "$output" | head -n 20 | while IFS= read -r line; do
            log "  $line"
        done
        return 0
    fi
}

# 1. Stops Server
#run_lgsm "stop" || error "Server failed to stop"
#sleep 10

# 2. Updates Server
run_lgsm "update" || error "Server update failed"

# 3. Updates Mods (Plugins)
run_lgsm "mods-update" || log "Mods update had issues (might be normal if no updates)"

# 4. Starts Server
run_lgsm "start" || error "Failed to start server"

# Logging Server has started and will sleep to allow server to start up and replace files
log "Server started. Sleeping 60 seconds..."
sleep 60

# 5. Stop Server
run_lgsm "stop" || error "Failed to stop server"
sleep 10

# 6. Reinstall Mods (Plugins)
run_lgsm "mods-update" || log "Mods reinstall completed with warnings"
sleep 10

# 7. Start again
run_lgsm "start" || error "Failed to restart server"

# 8. Logging if successfully updated server and mods
log "=== ServerStart completed successfully ==="
# End of the script














########################################This is Depricated################################################
#DIR="$(cd "$(dirname "$0")/../../" && pwd)"
#source "$DIR/config.sh"

###########################################################################################################
##                                        SERVER-START                                                   ##
## Updates server, starts server, stops server, updates mods, starts server. This is to allow the server ##
## to update and then starts server. This is due to some updates wipe out file system for the mods. Then ##
## starts server after updates.                                                                          ##
##                                   BY: ALIENATEDMAMMAL                                                 ##
##                                                                                                       ##
###########################################################################################################

# Updating Server
#       $SAY $SCRIPTSERVERSTART $SERVERNAME Updating Server...>> $LOGS
# $USER $SERVER update >> $LOGS

# Starting and stoping server then updating Mods
#        $SAY $SCRIPTSERVERSTART $SERVERNAME Server updaing Mods... >> $LOGS
# $USER $SERVER start >> $LOGS &&
#        $SAY $SCRIPTSERVERSTART $SERVERNAME Server will sleep for 60 seconds >> $LOGS
# read -t 60
#        $SAY $SCRIPTSERVERSTART $SERVERNAME Server sleep completed stopping server >> $LOGS
# $USER $SERVER stop >> $LOGS
#        $SAY $SCRIPTSERVERSTART $SERVERNAME Server mods updating >> $LOGS
# $USER $SERVER mods-update >> $LOGS
#        $SAY $SCRIPTSERVERSTART $SERVERNAME Mods updated... >> $LOGS

# Starting Server
#        $SAY $SCRIPTSERVERSTART $SERVERNAME Starting server... >> $LOGS
# $USER $SERVER start >> $LOGS
#        $SAY $SCRIPTSERVERSTART $SERVERNAME Server Has Started >> $LOGS ||
#        $SAY $SCRIPT$SCRIPTSERVERSTART $SERVERNAME Server Has Failed To Start >> $LOGS

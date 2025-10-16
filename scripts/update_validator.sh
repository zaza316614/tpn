#!/bin/bash

# Default values for flags
TPN_DIR=~/tpn-subnet
ENABLE_AUTOUPDATE=true
FORCE_RESTART=true
PM2_PROCESS_NAME=tpn_validator

# Help message
print_help() {
  echo "Usage: $0 [OPTIONS]"
  echo ""
  echo "Options:"
  echo "  --tpn_dir=PATH               Path to the TPN repository (default: ~/tpn-subnet)"
  echo "  --enable_autoupdate=true|false  Enable or disable crontab auto-update (default: true)"
  echo "  --force_restart=true|false     Force restart regardless of repository update (default: true)"
  echo "  --pm2_process_name=NAME        Name of the pm2 process to restart (default: tpn_validator)"
  echo "  --help                         Show this help message and exit"
  exit 0
}

# Parse command-line arguments
for arg in "$@"; do
  case $arg in
    --tpn_dir=*)
      TPN_DIR="${arg#*=}"
      shift
      ;;
    --enable_autoupdate=*)
      ENABLE_AUTOUPDATE="${arg#*=}"
      shift
      ;;
    --force_restart=*)
      FORCE_RESTART="${arg#*=}"
      shift
      ;;
    --pm2_process_name=*)
      PM2_PROCESS_NAME="${arg#*=}"
      shift
      ;;
    --help|-h)
      print_help
      ;;
    *)
      echo "Unknown argument: $arg"
      echo "Use --help to see available options."
      exit 1
      ;;
  esac
done

# Check for TPN repository
if [ ! -d "$TPN_DIR" ]; then
    echo "TPN repository not found at $TPN_DIR. Please clone it first."
    exit 1
fi

# Define the command to ensure in crontab
restart_command="0 * * * * $TPN_DIR/scripts/update_validator.sh --force_restart=false"

if [ "$ENABLE_AUTOUPDATE" = "true" ]; then
    # Dump crontab, fallback to empty if none exists
    existing_cron=$(crontab -l 2>/dev/null || true)
    
    # Check if restart_command already exists
    if ! echo "$existing_cron" | grep -Fq "$restart_command"; then
        # Remove any old validator update entries
        new_cron=$(echo "$existing_cron" | grep -v "scripts/update_validator.sh")

        # Add the correct restart_command
        printf "%s\n%s\n" "$new_cron" "$restart_command" | crontab -
    fi
else
    echo "Autoupdate disabled, skipping crontab check."
fi

# If we are on development branch, git stash before pulling
if [ "$(git -C "$TPN_DIR" rev-parse --abbrev-ref HEAD)" = "development" ]; then
    echo "On development branch, stashing changes before pulling."
    git -C "$TPN_DIR" stash push -m "Stash before update on $(date)" || {
        echo "Failed to stash changes, continuing anyway."
    }
fi 

# Update the TPN repository
cd "$TPN_DIR" || exit 1
git pull 2>&1 | tee /dev/stderr | grep -c "Already up to date."; REPO_UP_TO_DATE=$?

# On dev branch, pop the stash if it was created
if [ "$(git -C "$TPN_DIR" rev-parse --abbrev-ref HEAD)" = "development" ] && [ -n "$(git stash list)" ]; then
    echo "Popping stash after pull on development branch."
    git -C "$TPN_DIR" stash pop || {
        echo "Failed to pop stash, continuing anyway."
    }
fi

# If force_restart flag is true, pretend repo is not up to date
if [ "$FORCE_RESTART" = "true" ]; then
    echo "Force restart enabled, treating repository as changed."
    REPO_UP_TO_DATE=0
fi

# Pull the latest docker images
docker compose -f node-stack/validator/validator.docker-compose.yml pull

# Restart the validator docker container if needed
if [ "$REPO_UP_TO_DATE" -eq 0 ]; then
    echo "Repository has changes, force restarting docker process..."
    docker compose -f node-stack/validator/validator.docker-compose.yml down
    echo "Pruning unused images..."
    docker image prune -f || echo "Failed to prune unused images."
    echo "Pruning unused networks..."
    docker network prune -f || echo "Failed to prune unused networks."
else
    echo "No changes in the repository, no need to force restart docker."
fi

# Bring validator back up
docker compose -f node-stack/validator/validator.docker-compose.yml up -d

# Restart the pm2 process if needed
if [ "$REPO_UP_TO_DATE" -eq 0 ]; then
    echo "Repository has changes, restarting pm2 process $PM2_PROCESS_NAME..."
    pm2 restart "$PM2_PROCESS_NAME"
else
    echo "No changes in the repository, skipping pm2 restart."
fi

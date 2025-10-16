# Use linuxserver wireguard image base
FROM lscr.io/linuxserver/wireguard:latest

# Modify the startup script so it always regenerates the client files that are missing
# by appending "generate_confs" to the /etc/s6-overlay/s6-rc.d/init-wireguard-confs/run script
RUN echo "echo 'Force-generating missing wireguard config files'" >> /etc/s6-overlay/s6-rc.d/init-wireguard-confs/run
RUN echo "generate_confs" >> /etc/s6-overlay/s6-rc.d/init-wireguard-confs/run

# Disable qrencode lines by commenting them out
RUN sed -i 's/^qrencode/#qrencode/' /etc/s6-overlay/s6-rc.d/init-wireguard-confs/run

# Edit the generate_confg function so there is a force block option
RUN sed -i '/^[[:space:]]*generate_confs () {/a\
    if [[ -n "$FORCE_BLOCK_CONFIG_GENERATION" ]]; then echo "Force blocking config generation due to FORCE_BLOCK_CONFIG_GENERATION being set"; return; fi' /etc/s6-overlay/s6-rc.d/init-wireguard-confs/run

# Add a healthcheck
HEALTHCHECK --interval=2s --timeout=2s --start-period=120s --retries=5 CMD ip link show wg0

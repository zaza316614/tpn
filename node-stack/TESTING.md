# Off chain testing

- 2 vps, one for miner one for validator
- git clone https://github.com/beyond-stake/tpn-subnet.git && tpn-subnet && git checkout development
- curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash && source ~/.zshrc && nvm install && nvm use
- On validator make .env and be sure to add
    - CI_MODE=true
    - PUBLIC_VALIDATOR_URL=http://ipaddress
    - Docker compose comment out image
    - docker compose -f validator.docker-compose.yml build --build-arg CACHEBUST=$(date +%s) && docker compose -f validator.docker-compose.yml up; docker compose -f validator.docker-compose.yml down -v
    - npm i && npm test
- On miner make .env
    - CI_MODE=true
    - WIREGUARD_PEER_COUNT=5
    - PUBLIC_VALIDATOR_URL=http://ipaddress
    - Docker compose comment out image
    - docker compose -f miner.docker-compose.yml build --build-arg CACHEBUST=$(date +%s) && docker compose -f miner.docker-compose.yml up; docker compose -f miner.docker-compose.yml down -v
    - npm i && npm test -- challenge.test.js


# On chain testing

Testnet details:

- 
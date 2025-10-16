# The MIT License (MIT)
# Copyright © 2023 Yuma Rao
# TODO(developer): Set your name
# Copyright © 2023 <your name>

# Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
# documentation files (the “Software”), to deal in the Software without restriction, including without limitation
# the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software,
# and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

# The above copyright notice and this permission notice shall be included in all copies or substantial portions of
# the Software.

# THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
# THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
# THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
# OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
# DEALINGS IN THE SOFTWARE.

import time
import math
import bittensor as bt
import asyncio
import aiohttp
import numpy as np

from sybil.validator.utils import generate_challenges
from sybil.validator.reward import get_rewards
from sybil.base.consts import BURN_UID, BURN_WEIGHT

async def forward(self):
    """
    The forward function is called by the validator every time step.

    It is responsible for querying the network and scoring the responses.

    Args:
        self (:obj:`bittensor.neuron.Neuron`): The neuron object which contains all the necessary state for the validator.

    """
    
    # Post miner and validator info to the container    
    await broadcast_neurons(self.metagraph, self.validator_server_url)
    
    # initialize the total rewards
    all_rewards = []
    
    # shuffle the miner uids
    shuffled_miner_uids = np.random.permutation(self.metagraph.n.item())
    bt.logging.info(f"Number of shuffled miner uids in total: {len(shuffled_miner_uids)}")
    
    # remove the uids with duplicate ips
    unique_ips = set()
    unique_miner_uids = []
    for uid in shuffled_miner_uids:
        ip = self.metagraph.axons[uid].ip
        if ip not in unique_ips:
            unique_ips.add(ip)
            unique_miner_uids.append(uid)
    
    shuffled_miner_uids = np.array(unique_miner_uids)
    bt.logging.info(f"Number of miner uids after removing duplicate IPs: {len(shuffled_miner_uids)}")
    
    batch_size = self.config.neuron.sample_size
    num_batches = math.ceil(len(shuffled_miner_uids) / batch_size)
    
    # iterate all the shuffled miner uids by batch size
    for i in range(num_batches):
        # get the miner uids for the current batch
        miner_uids = shuffled_miner_uids[i*batch_size:(i+1)*batch_size]
        bt.logging.info(f"Batch {i+1} ==> Miner uids: {miner_uids}")
        
        # Generate k challenges
        challenges = await generate_challenges(miner_uids=miner_uids, validator_server_url=self.validator_server_url)
        bt.logging.info(f"Batch {i+1} ==> Generated challenges:\n" + "\n".join([str(challenge) for challenge in challenges]))
        
        # Check if challenges is None or an empty list
        if challenges is None or len(challenges) == 0:
            bt.logging.error("Batch {i+1} ==> Failed to generate challenges")
            time.sleep(10)
            return

        # Create concurrent queries, one for each challenge-miner pair
        async_queries = [
            self.dendrite(
                axons=[self.metagraph.axons[uid]],
                synapse=challenge,
                deserialize=True,
                timeout=120.0,
            )
            for uid, challenge in zip(miner_uids, challenges)
        ]

        # Execute all queries concurrently
        responses = await asyncio.gather(*async_queries)

        bt.logging.info(f"Batch {i+1} ==> Received Raw responses: {responses}")
        # Flatten the responses list since each query returns a list with one item
        responses = [resp[0] for resp in responses]

        # Log the results for monitoring purposes.
        bt.logging.info(f"Batch {i+1} ==> Received responses: {responses}")
        
        # Get scores for the responses
        rewards = await get_rewards([challenge.challenge for challenge in challenges], responses, validator_server_url=self.validator_server_url)
        bt.logging.info(f"Batch {i+1} ==> Scores: {rewards}")
        
        if rewards is None:
            bt.logging.error(f"Batch {i+1} ==> Failed to get rewards. Adding 0 scores to the total rewards")
            all_rewards.extend([0] * len(miner_uids))
            continue

        all_rewards.extend(rewards)

    # Update the scores based on the rewards. You may want to define your own update_scores function for custom behavior.
    bt.logging.info(f"Updating final scores: {all_rewards}")

    # Check that the score array is of equal length to the shuffled miner uids, only post updates to chain if so
    if len(all_rewards) == len(shuffled_miner_uids):
        bt.logging.info(f"Length match: {len(all_rewards)} rewards for {len(shuffled_miner_uids)} miner uids. Posting updates to chain.")

        # Update the scores in the metagraph
        self.update_scores(all_rewards, shuffled_miner_uids)

    else:
        bt.logging.error(f"Length mismatch: {len(all_rewards)} rewards for {len(shuffled_miner_uids)} miner uids. Not posting updates to chain.")

    time.sleep(10)


async def broadcast_neurons(metagraph, server_url):
    """
    Broadcast the neurons to the server.
    """
    bt.logging.info(f"Broadcasting neurons to {server_url}/protocol/broadcast/neurons")

    neurons_info = []
    block = int(metagraph.block)
    for neuron in metagraph.neurons:
        uid = neuron.uid
        neurons_info.append({
            'uid': uid,
            'ip': metagraph.axons[uid].ip,
            'validator_trust': neuron.validator_trust,
            'trust': neuron.trust,
            "alpha_stake": float(metagraph.alpha_stake[uid].item()),
            'stake_weight': float(metagraph.S[uid].item()),
            'block': block,
            'hotkey': neuron.hotkey,
            'coldkey': neuron.coldkey,
            'excluded': uid == BURN_UID,
        })
    bt.logging.info(f"Submitting neurons info: {len(neurons_info)} neurons")
    try:     
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{server_url}/protocol/broadcast/neurons",
                json={"neurons": neurons_info}
            ) as resp:
                result = await resp.json()
                if result["success"]:
                    bt.logging.info(f"Broadcasted neurons info: {len(neurons_info)} neurons")
                else:
                    bt.logging.error(f"Failed to broadcast neurons info")
    except Exception as e:
        bt.logging.error(f"Failed to broadcast neurons info: {e}")
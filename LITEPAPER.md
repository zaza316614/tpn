# TAO Private Network litepaper

TAO Private Network is designed to query public internet resources from a network of highly diverse node operators. It solves use-cases where an entity wants to query a resource and wants to have a freedom of choice on how the resource perceives them digitally. Example of this include:

- Geo control: An internet user that wants to know how a webpage looks when it is opened from a geolocation different than where the user is. For example a user in an area with restricted internet circumstances that wants to open a resource blocked by their ISP.
- Fresh identities: A researcher that wants to open a webpage, but wants the webpage to perceive it as a new user instead of a recurring one.
- Privacy preservation: A user who wants to open a web-hosted resource without the host knowing their fingerprint, like where they are, which browser they are using, and so forth.

The integrity of the behaviour of miners will be safeguarded based on challenge/response tests combined with randomised sampling that slashes internal reputation in the weight setting of validators.

This litepaper details the development roadmap of this Bittensor subnet.

## V0: network bootstrapping

The first version of the TPN subnet incentivises miners and validators to set up a globally distributed network of nodes. Good behaviour is rewarded, and undesired behaviour is not. In this phase:

- Validators host a challenge/response endpoint and ask miners to supply the response as a challenge endpoint
- Miners receive challenge urls, and send the challenge response to validators
- The challenge/response endpoint scores miners based on the metrics of geolocation uniqueness, connection type, and response speed

Because the topology of the internet is relatively well mapped, we can classify an ip address based on where in the world they are, and what connection type they have (e.g. residential vs data center). This allows for scoring where validators incentivise miners to set up modes in locations that are more useful to end users. This prevents miners from all running in the same datacenter, which would be counter to the intention of this subnet.

Example flow:

1. Validator tells miner with ip `1.2.3.4` to open the challenge at `http://4.3.2.1/challenge/un-iq-ue-id`, knowing the secret for `un-iq-ue-id` is `un-iq-ue-sec-ret`
2. Miner calls a `GET http://4.3.2.1/challenge/un-iq-ue-id` request and receives the response `un-iq-ue-sec-ret`, which it supplies to the validator
3. The validator checks from which ip the `http://4.3.2.1/challenge/un-iq-ue-id` was called and scored the opening of this challenge based on location uniqueness, connection type, and response speed
4. The validator sets miner weights based on a ranking of all opened challenge/response pairs that it requested from each miners

## V1: static querying

Once the network bootstrapping phase is complete, we will add a validator endpoint that will allow users to request arbitrary URLs to be opened.

Validators will score miner responses based on an additional criterion. They will through random sampling open user-provided URLs and if the miner response is invalid, the validator will down-rank the miner.

Note that the challenge/response mechanic of V0 will remain active as a basic validation that miners are acting in accordance to the rules.

## V2: advanced querying

One of the issues that automated systems run into is that webpages are increasingly complex and dynamically generated. Imagine an automated program that would like to view the content of a webpage that is relatively convoluted. A normal user would need to take the following steps:

1. Open the webpage
2. Accept terms of service
3. Dismiss a cookie banner
4. Expand the webpage main content
5. Expand all comments on the page
6. Read the page

An automated program cannot simply do a `GET` request to get this content, as it is all dynamically loaded. Under V2 the user (an automated program in this case) could request a query that does all the above:

```
{
	url: "https://coolforum.com/post/12345",
	browser: "chromium",
	waitfor: [ "network-idle" ],
	actions: [
		{ type: "type", target: "input#terms-of-service", content: "yes" },
		{ type: "action.click", target: "button#accept-tos" },
		{ type: "action.click", target: "button#accept-cookies" },
		{ type: "action.clickall", target: ".collapsed" },
		{ type: "action.clickall", target: ".comments a.expand" }
	],
	hide_elements: [ "div.ads", "nav.menu" ],
	response: "pdf"
}
```

This would tell a miner to open the webpage in an automated Chromium browser instance, accept all dialogues, expand all content, take a pdf snapshot, and return the pdf.

This kind of flexible querying can allow users to do things like:

1. Extract an ad-free text of an article behind a paywall they have logins for, returned as plain text.
2. Generate pdf files with superfluous visual elements (like menus, predictable ad placements, etc) stripped out.
3. Access webpage elements that are usually only available to human users to machine entities like AI actors

At this stage the challenge/response system of V0 will be upgraded. Instead of simple responses, the miner will complete challenge webpages that include anti-machine measures like captcha checks.

## V3: arbitrary networking through VPN connections

At this stage, miners would not just fulfil requests, but offer their connection to users. This would allow users to access a very diverse set of ip addresses.

Common issues with commercial VPN providers include the fact that content hosts and ISPs are often able to blacklist these providers. The diverse network of the TPN subnet would be resistant to this issue since the ip addresses used by miners are incentivised to be in locations and on connections that look like regular residential users.

In this setup the validators would be the entry point for a user wanting a VPN connection. The validator would select a suitable miner through a challenge-response check. The miner response with a response to the challenge, as well as a VPN connection configuration file.

The validator would use this file to test the connection, and supply it to the end user. Liveness checks are done on the validator level, and if the miner goes dormant, the user is supplied with an updated configuration file that corresponds to a miner with a live status.

## V4: consumer-level integrations

Given the diverse and versatile nature of the TPN subnet, it would be suitable not only for automated actors, but also for consumers.

This unlocks advanced use-cases that are not currently possible in traditional web2 VPN setups. For example, a user might request a connection that:

1. is located in Argentina, but changes ip address every 5 minutes
2. rotates between ip addresses in Italy, Greece, and Portugal on an unpredictable interval
3. selects that fastest available connection, so long as the ip address of the connection is outside of the United States

These highly granular and diverse levels of connection selections will allow human and artificial users a highly customisable, privacy preserving, and censorship resistant way of accessing the public internet.

# About the team

The TPN subnet is an initiative of the team behind the [Taofu protocol](https://taofu.xyz/). For an overview, refer to [this Notion page](https://octagonal-thyme-e01.notion.site/Core-team-1495ba3d459e8044b54fcd2e52b8b309?pvs=74).

Technical expertise relevant to the TPN subnet:

- Just, an ex-Parity engineer with extensive experience with the Polkadot/substrate tech stack. His code can be found in the polkadot and core XCM codebase
- Mentor, a web2/web3 engineer who ran two small VPN companies, sold the first one, and operated the second as a non-profit for 8 years. He also created [OnionDAO](https://oniondao.web.app/), a collective that incentivises Tor exit nodes.

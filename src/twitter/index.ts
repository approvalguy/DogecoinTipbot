import "../common/load-env"
import { dbPromise } from "../common/load-db"
import Twit, {ETwitterStreamEvent, TweetEntitiesV1} from "twitter-api-v2"
import Command from "./command"
import { promises as fs } from "fs"
import { join } from "path"
import { Autohook } from "twitter-autohook"
import { walletConnection } from "../cryptocurrencies/vite"
import Address from "../models/Address"
import { tokenTickers } from "../common/constants"
import { convert, tokenNameToDisplayName } from "../common/convert"
import { fetchUser } from "./users"
import { isAuthorized, setAuthorized } from "./dmauthorization"
import { parseTransactionType } from "../wallet/address"

export const twitc = new Twit({
    appKey: process.env.TWITTER_API_KEY,
    appSecret: process.env.TWITTER_API_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET
})
export const twitcBearer = new Twit(process.env.TWITTER_BEARER_TOKEN)

export const commands = new Map<string, Command>()
export const rawCommands = [] as Command[]

export interface TwitterUser {
    id: string,
    name: string,
    screen_name: string,
    location: string,
    url: string,
    description: string,
    translator_type: string,
    protected: boolean,
    verified: boolean,
    followers_count: number,
    friends_count: number,
    listed_count: number,
    favourites_count: number,
    statuses_count: number,
    created_at: string,
    geo_enabled: boolean,
    lang: string,
    contributors_enabled: boolean,
    is_translator: boolean,
    profile_background_color: string,
    profile_background_image_url: string,
    profile_background_image_url_https: string,
    profile_background_tile: boolean,
    profile_link_color: string,
    profile_sidebar_border_color: string,
    profile_sidebar_fill_color: string,
    profile_text_color: string,
    profile_use_background_image: boolean,
    profile_image_url: string,
    profile_image_url_https: string,
    profile_banner_url: string,
    default_profile: boolean,
    default_profile_image: boolean
}

export interface DMMessage {
    id: string,
    text: string,
    user: TwitterUser,
    entities: TweetEntitiesV1
}

export const mention = "@vitctipbot"
let nonce = 0

fs.readdir(join(__dirname, "commands"), {withFileTypes: true})
.then(async files => {
    for(const file of files){
        if(!file.isFile())continue
        if(!file.name.endsWith(".js") && !file.name.endsWith(".ts"))continue
        const mod = await import(join(__dirname, "commands", file.name))
        const command:Command = mod.default

        if(!command.hidden)rawCommands.push(command)
        for(const alias of command.alias){
            commands.set(alias, command)
        }
    }
    // wait for db before launching bot
    
    await dbPromise

    walletConnection.on("sbp_rewards", async message => {
        const text = `Today's 💊 voter rewards were sent!

${Math.round(parseFloat(convert(message.vite, "RAW", "VITE")))} ${tokenNameToDisplayName("VITE")}!

And

${Math.round(parseFloat(convert(message.vitc, "RAW", "VITC")))} ${tokenNameToDisplayName("VITC")}!

Thanks to all our voters!`

        await twitc.v1.tweet(text)
    })

    walletConnection.on("tx", async transaction => {
        if(transaction.type !== "receive")return
        
        const address = await Address.findOne({
            address: transaction.to
        })
        // shouldn't happen but
        if(!address)return

        // Don't send dm on random coins, for now just tell for registered coins.
        if(!(transaction.token_id in tokenTickers))return
        
        const tokenName = tokenTickers[transaction.token_id]
        const displayNumber = convert(
            transaction.amount, 
            "RAW", 
            tokenName
        )
        let text = `

View transaction on VITCScan: https://vitcscan.com/tx/${transaction.hash}`

        const sendingAddress = await Address.findOne({
            address: transaction.from,
            network: "VITE"
        })
        const notif = parseTransactionType(sendingAddress?.handles?.[0], transaction.sender_handle)
        text = notif.text
            .replace(/\*+/g, "")
            .replace("{amount}", `${displayNumber} ${tokenNameToDisplayName(tokenName)}`)
            + text
        if(notif.type === "rewards")return
        if(notif.type === "tip"){
            let mention = ""
            if(notif.platform == "Discord"){
                mention = `https://discord.com/users/${notif.id}`
            }else if(notif.platform == "Twitter"){
                try{
                    const user = await fetchUser(notif.id)
                    mention = `@${user.username}`
                }catch{
                    mention = `https://twitter.com/i/user/${notif.id}`
                }
            }else{
                mention = `${notif.platform}:${notif.id}`
            }
            text = text.replace("{mention}", mention)
        }
        const [id, service] = address.handles[0].split(".")
        switch(service){
            case "Twitter": {
                if(!await isAuthorized(id))break
                await twitc.v1.sendDm({
                    recipient_id: id,
                    text: text
                })
                break
            }
        }
    })
    const [
        account,
        rules
    ] = await Promise.all([
        twitc.v1.verifyCredentials(),
        twitcBearer.v2.streamRules()
    ])
    
    if(rules.data?.length){
        await twitcBearer.v2.updateStreamRules({
            delete: {
                ids: rules.data.map(e => e.id)
            }
        })
    }
    await twitcBearer.v2.updateStreamRules({
        add: [
            {
                value: mention,
                tag: "mention"
            }
        ]
    })

    // normal tweets
    const streamFilter = await twitcBearer.v2.searchStream({
        expansions: [
            "author_id",
            "in_reply_to_user_id",
            "referenced_tweets.id"
        ]
    })
    streamFilter.autoReconnect = true
    streamFilter.autoReconnectRetries = Infinity
    streamFilter.on(ETwitterStreamEvent.Data, async (data) => {
        const tweet = data.data
        if(!tweet){
            // for some reasons...
            console.log("INVALID: ", data)
            return
        }
        // retweet
        if(tweet.referenced_tweets?.find(e => e.type === "retweeted"))return
        if(tweet.author_id === account.id_str)return
        console.log(tweet)
        const tempArgs = tweet.text.toLowerCase().split(/( |\n)+/g)
        const mentionIndexs = []
        // eslint-disable-next-line no-constant-condition
        while(true){
            if(!tempArgs.length)break
            const mentionIndex = tempArgs.indexOf(mention)
            if(mentionIndex < 0)break
            // remove the mention to avoid loops
            tempArgs[mentionIndex] = ""
            mentionIndexs.push(mentionIndex)
        }
        
        // not mentionned.
        if(!mentionIndexs.length)return
        for(const mentionIndex of mentionIndexs){
            const args = tweet.text.split(/( |\n)+/g).slice(mentionIndex+1).filter(e => !!e.trim())
            const command = args.shift()?.toLowerCase()?.replace(/^\./, "") || ""
            
            const cmd = commands.get(command)
            console.log(command, args)
            if(!cmd?.public)continue
            const n = nonce++
    
            try{
                await cmd.executePublic(tweet, args, command)
            }catch(err){
                if(!(err instanceof Error) && "error" in err){
                    // eslint-disable-next-line no-ex-assign
                    err = JSON.stringify(err.error, null, "    ")
                }
                console.error(`${command} Twitter ${n}`, err)
                await twitc.v1.reply(
                    `An unknown error occured. Please report that to devs (cc @NotThomiz): Execution ID ${n}`, 
                    tweet.id
                )
            }
        }
    })
    const webhook = new Autohook({
        consumer_key: process.env.TWITTER_API_KEY,
        consumer_secret: process.env.TWITTER_API_SECRET,
        token: process.env.TWITTER_ACCESS_TOKEN,
        token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
        ngrok_secret: process.env.NGROK_AUTH_TOKEN,
        env: "prod",
        port: 1765
    })
    await webhook.removeWebhooks()
    
    const prefixHelp = new Set<string>()

    webhook.on("event", async msg => {
        // likely typing in dms, we don't care about those.
        if(!("direct_message_events" in msg))return
        for(const event of msg.direct_message_events){
            if(event.type !== "message_create")continue
            const user = msg.users[event.message_create.sender_id]
            if(user.id === account.id_str)continue
            await setAuthorized(user.id)
            const message:DMMessage = {
                entities: event.message_create.message_data.entities,
                id: event.id,
                text: event.message_create.message_data.text,
                user: user
            }
            if(!message.text.startsWith(".")){
                if(prefixHelp.has(user.id))continue
                prefixHelp.add(user.id)
                setTimeout(() => {
                    prefixHelp.delete(user.id)
                }, 10*60*1000)
                await twitc.v1.sendDm({
                    recipient_id: message.user.id,
                    text: "Hey 👋, The prefix for all my commands is period (.) You can see a list of all commands by sending .help"
                })
                continue
            }
            const args = message.text.slice(1).trim().split(/ +/g)
            const command = args.shift().toLowerCase()

            const cmd = commands.get(command)
            if(!cmd?.dm)continue

            const n = nonce++

            try{
                await cmd.executePrivate(message, args, command)
            }catch(err){
                if(!(err instanceof Error) && "error" in err){
                    // eslint-disable-next-line no-ex-assign
                    err = JSON.stringify(err.error, null, "    ")
                }
                console.error(`${command} Twitter ${n}`, err)
                await twitc.v1.sendDm({
                    recipient_id: user.id,
                    text: `An unknown error occured. Please report that to devs (@NotThomiz): Execution ID ${n}`
                })
            }
        }
    })

    await webhook.start()
  
    await webhook.subscribe({
        oauth_token: process.env.TWITTER_ACCESS_TOKEN,
        oauth_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET
    })
})
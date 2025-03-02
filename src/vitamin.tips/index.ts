import "../common/load-env"
import express, { Router } from "express"
import { dbPromise } from "../common/load-db"
import tips from "./api/tips"
import address from "./api/address"
import * as Discord from "discord.js"
import Twit from "twitter-api-v2"
import bank from "./api/bank"
import { randomBytes, randomUUID } from "crypto"
import { getVITEAddressOrCreateOne } from "../wallet/address"
import APIProject from "../models/APIProject"
import vpow from "./api/vpow"
import vite from "./api/vite"

export const discordClient = new Discord.Client({
    intents: [
        Discord.Intents.FLAGS.GUILDS,
        Discord.Intents.FLAGS.GUILD_MESSAGES,
        Discord.Intents.FLAGS.DIRECT_MESSAGES,
        Discord.Intents.FLAGS.GUILD_MEMBERS,
        Discord.Intents.FLAGS.GUILD_MESSAGE_REACTIONS
    ]
})
// lol use a deprecated bot so even if we get banned, we have nothing to lose.
discordClient.token = process.env.DISCORD_TOKEN_872912021379752026

export const twitc = new Twit({
    appKey: process.env.TWITTER_API_KEY,
    appSecret: process.env.TWITTER_API_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET
})
export const twitcBearer = new Twit(process.env.TWITTER_BEARER_TOKEN)

export const app = express()
.use(
    "/api",
    Router()
    .use("/address", address)
    .use("/tips", tips)
    .use("/bank", bank)
    .use("/vpow", vpow)
    .use("/vite", vite)
)

dbPromise.then(() => {
    app.listen(3060, () => {
        console.log("Listening on http://127.0.0.1:3060")
    })

    /*
    const id = randomUUID()

    getVITEAddressOrCreateOne(id, "Bank")
    .then(address => {
        const key = randomBytes(32).toString("hex")
        console.log(key)
        APIProject.create({
            key,
            name: "Proof of Sweat",
            addresses: [
                address.address
            ],
            project_id: id
        })
    })*/
})
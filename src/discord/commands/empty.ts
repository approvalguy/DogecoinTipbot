import { Message } from "discord.js";
import { defaultEmoji, tokenIds } from "../../common/constants";
import { convert } from "../../common/convert";
import { getVITEAddressOrCreateOne } from "../../wallet/address";
import Command from "../command";
import discordqueue from "../discordqueue";
import { generateDefaultEmbed } from "../util";
import help from "./help";
import BigNumber from "bignumber.js"
import viteQueue from "../../cryptocurrencies/viteQueue";
import * as vite from "@vite/vitejs"
import Address from "../../models/Address";
import { BOT_OWNER } from "../constants";
import { requestWallet } from "../../libwallet/http";

export default new class EmptyCommand implements Command {
    description = "Withdraw the funds on the tipbot from a stuck address"
    extended_description = ``

    alias = ["empty"]
    usage = "<amount|all> {currency} <address>"
    hidden = true

    async execute(message:Message, args: string[], command: string){
        if(message.author.id !== BOT_OWNER)return
        let [
            // eslint-disable-next-line prefer-const
            amountRaw,
            currencyOrRecipient,
            addr
        ] = args
        if(!amountRaw || !currencyOrRecipient)return help.execute(message, [command])
        if(!/^\d+(\.\d+)?$/.test(amountRaw) && amountRaw !== "all")return help.execute(message, [command])
        if(vite.wallet.isValidAddress(currencyOrRecipient)){
            // user here
            addr = currencyOrRecipient
            currencyOrRecipient = "vitc"
        }
        let isRawTokenId = false
        currencyOrRecipient = currencyOrRecipient.toUpperCase()

        if(!(currencyOrRecipient in tokenIds)){
            if(vite.utils.isValidTokenId(currencyOrRecipient.toLowerCase())){
                isRawTokenId = true
                currencyOrRecipient = currencyOrRecipient.toLowerCase()
            }else{
                const embed = generateDefaultEmbed()
                .setDescription(`The token ${currencyOrRecipient} isn't supported.`)
                await message.channel.send({
                    embeds: [embed]
                })
                return
            }
        }
        if(!addr)return help.execute(message, [command])

        const [
            address,
            recipient
        ] = await Promise.all([
            Address.findOne({
                address: addr
            }),
            discordqueue.queueAction(message.author.id, async () => {
                return getVITEAddressOrCreateOne(message.author.id, "Discord")
            })
        ])
        if(!address){
            await message.reply("This address isn't managed by the tipbot.")
            return
        }

        await viteQueue.queueAction(address.address, async () => {
            try{
                await message.react(defaultEmoji)
            }catch{}
            const balances = await requestWallet("get_balances", address.address)
            const token = isRawTokenId ? currencyOrRecipient : tokenIds[currencyOrRecipient]
            const balance = new BigNumber(token ? balances[token] || "0" : "0")
            const amount = new BigNumber(amountRaw === "all" ? balance : convert(amountRaw, currencyOrRecipient, "RAW"))
            if(balance.isLessThan(amount)){
                try{
                    await message.react("❌")
                }catch{}
                await message.author.send({
                    content: `The address doesn't have enough money to cover this empty. It needs ${convert(amount, "RAW", currencyOrRecipient)} ${currencyOrRecipient} but it only has ${convert(balance, "RAW", currencyOrRecipient)} ${currencyOrRecipient} in its balance.`,
                    reply: {
                        messageReference: message,
                        failIfNotExists: false
                    }
                })
                return
            }
            const tx = await requestWallet(
                "send",
                address.address, 
                recipient.address, 
                amount.toFixed(), 
                token
            )
            try{
                await message.react("909408282307866654")
            }catch{}
            await message.channel.send({
                content: `Emptying Done!

View transaction on VITCScan: https://vitcscan.com/tx/${tx.hash}`,
                reply: {
                    messageReference: message,
                    failIfNotExists: false
                }
            })
        })
    }
}
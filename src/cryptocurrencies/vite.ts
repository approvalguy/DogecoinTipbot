import { Platform, tokenIds } from "../common/constants";
import Address, { IAddress } from "../models/Address";
import * as vite from "@vite/vitejs";
import WS_RPC from "@vite/vitejs-ws";
import { client } from "../discord";
import viteQueue from "./viteQueue";
import { convert, tokenNameToDisplayName } from "../common/convert";
import { parseDiscordUser } from "../discord/util";
import { retryAsync, wait } from "../common/util";
import BigNumber from "bignumber.js";
import PendingTransaction, { IPendingTransactions } from "../models/PendingTransaction";
import { EventEmitter } from "events";
import PoWManager from "./PoWManager";

export const viteEvents = new EventEmitter()

const skipBlocks = []
let promisesResolveSnapshotBlocks = []
const hashToSender = {}

const wsService = new WS_RPC(process.env.VITE_WS, 6e5, {
    protocol: "",
    headers: "",
    clientConfig: "",
    retryTimes: Infinity,
    retryInterval: 10000
})/*
const powWSService = new WS_RPC("wss://node-tokyo.vite.net/ws", 6e5, {
    protocol: "",
    headers: "",
    clientConfig: "",
    retryTimes: Infinity,
    retryInterval: 10000
})
export const powWSProvider = new vite.ViteAPI(powWSService, async () => {})*/
export const wsProvider = new vite.ViteAPI(wsService, async () => {
    const SnapshotBlockEvent = await wsProvider.subscribe("createSnapshotBlockSubscription")
    SnapshotBlockEvent.on(() => {
        for(const r of promisesResolveSnapshotBlocks){
            r()
        }
        promisesResolveSnapshotBlocks = []
    })
    const AccountBlockEvent = await wsProvider.subscribe("createAccountBlockSubscription")
    AccountBlockEvent.on(async (result) => {
        try{
            if(skipBlocks.includes(result[0].hash))return
            const block = await wsProvider.request("ledger_getAccountBlockByHash", result[0].hash)
            if(!block)return
            if(block.blockType !== 2)return
            const address = await Address.findOne({
                address: block.toAddress,
                network: "VITE"
            })
            if(!address)return
            if(skipBlocks.includes(result[0].hash))return
            skipBlocks.push(result[0].hash)

            await receive(address, block)
            skipBlocks.splice(skipBlocks.indexOf(block.hash), 1)
        }catch(err){
            console.error(err)
        }
    })
})

export function waitForNextSnapshotBlock(){
    return new Promise(r => {
        promisesResolveSnapshotBlocks.push(r)
    })
}

export async function receive(address:IAddress, block:any){
    // Ok, we received a deposit/tip
    const keyPair = vite.wallet.deriveKeyPairByIndex(address.seed, 0)
    await viteQueue.queueAction(address.address, async () => {
        await retryAsync(async (tries) => {
            try{
                const accountBlock = vite.accountBlock.createAccountBlock("receive", {
                    address: address.address,
                    sendBlockHash: block.hash
                })
                accountBlock.setProvider(wsProvider)
                .setPrivateKey(keyPair.privateKey)
                await accountBlock.autoSetPreviousAccountBlock()
                const quota = await wsProvider.request("contract_getQuotaByAccount", address.address)
                const availableQuota = new BigNumber(quota.currentQuota).div(21000)
                if(availableQuota.isLessThan(1)){
                    //accountBlock.setProvider(powWSProvider)
                    await accountBlock.PoW()
                    accountBlock.setProvider(wsProvider)
                    /*const difficulty = await accountBlock.getDifficulty()
                    accountBlock.setDifficulty(difficulty)
                    const threshold = (2**256/(1+1/parseInt(difficulty))).toString(16)
                    const getNonceHash = vite.utils.blake2bHex(Buffer.concat([
                        Buffer.from(accountBlock.originalAddress, "hex"),
                        Buffer.from(accountBlock.previousHash, "hex")
                    ]), null, 32)
                    const work = await PoWManager.computeWork(getNonceHash, threshold)
                    accountBlock.setNonce(Buffer.from(work, "hex").toString("base64"))*/
                }
                await accountBlock.sign()
                await accountBlock.send()
            }catch(err){
                if(tries !== 2)await wait(20000)
                console.log(address)
                throw err
            }
        }, 3)
    })

    viteEvents.emit("receive_"+block.hash)

    // Don't send dm on random coins, for now just tell for registered coins.
    if(!Object.values(tokenIds).includes(block.tokenInfo.tokenId))return
    
    const tokenName = Object.entries(tokenIds).find(e => e[1] === block.tokenInfo.tokenId)[0]
    const displayNumber = convert(
        block.amount, 
        "RAW", 
        tokenName
    )
    let text = `

View transaction on vitescan: https://vitescan.io/tx/${block.hash}`
    const sendingAddress = await Address.findOne({
        address: block.fromAddress,
        network: "VITE"
    })
    if(sendingAddress){
        const [id, platform] = sendingAddress.handles[0].split(".")
        const [,,variant] = address.handles[0].split(".")
        let mention = "Unknown User"
        switch(platform){
            case "Discord": {
                let user = (await parseDiscordUser(id))[0]
                if(user.id === client.user.id){
                    //let's try to resolve the original id
                    const sender = hashToSender[block.hash]
                    if(sender){
                        delete hashToSender[block.hash]
                        const id = sender.split(".")[0]
                        const tempUser = (await parseDiscordUser(id))[0]
                        if(tempUser){
                            user = tempUser
                        }
                    }
                }
                if(user){
                    mention = user.tag
                }
                break
            }
            case "Faucet":{
                mention = "Faucet"
            }
        }
        switch(variant){
            case "Giveaway": 
                text = `${displayNumber} ${tokenNameToDisplayName(tokenName)} were locked for a giveaway.`+text
            break
            case "Airdrop": 
                text = `${displayNumber} ${tokenNameToDisplayName(tokenName)} were locked for an airdrop.`+text
            break
            default: 
                text = `You were tipped ${displayNumber} ${tokenNameToDisplayName(tokenName)} by ${mention} !`+text
        }
    }else{
        text = `${displayNumber} ${tokenNameToDisplayName(tokenName)} were deposited in your account's balance !`+text
    }
    for(const handle of address.handles){
        const [id, service] = handle.split(".")
        switch(service){
            case "Discord": {
                const user = client.users.cache.get(id)
                if(!user)return
                user.send(text).catch(()=>{})
                break
            }
        }
    }
}

export async function getVITEAddress(id:string, platform:Platform):Promise<IAddress>{
    const address = await Address.findOne({
        network: "VITE",
        handles: `${id}.${platform}`
    })
    if(!address)throw new Error("Couldn't find an address in DB")
    return address
}

export async function getVITEAddressOrCreateOne(id:string, platform:Platform):Promise<IAddress>{
    try{
        return await getVITEAddress(id, platform)
    }catch(err){
        const wallet = vite.wallet.createWallet()
        const addr = wallet.deriveAddress(0)
        // address doesn't exist in db, create it
        const address = await Address.create({
            network: "VITE",
            seed: wallet.seedHex,
            address: addr.address,
            handles: [
                `${id}.${platform}`
            ]
        })
        return address
    }
}

export async function bulkSend(from: IAddress, recipients: string[], amount: string, tokenId: string){
    const botAddress = await getVITEAddressOrCreateOne(client.user.id, "Discord")
    if(from.paused)throw new Error("Address frozen, please contact an admin.")
    const hash = await sendVITE(from.seed, botAddress.address, new BigNumber(amount).times(recipients.length).toFixed(), tokenId)
    await new Promise(r => {
        viteEvents.on("receive_"+hash, r)
    })
    const transactions = await rawBulkSend(botAddress, recipients, amount, tokenId, from.handles[0])
    return await Promise.all([
        Promise.resolve(hash),
        processBulkTransactions(transactions)
    ])
}

export async function processBulkTransactions(transactions:IPendingTransactions[]){
    const hashes = []
    while(transactions[0]){
        const transaction = transactions.shift()
        const hash = await viteQueue.queueAction(transaction.address.address, async () => {
            return sendVITE(transaction.address.seed, transaction.toAddress, transaction.amount, transaction.tokenId)
        })
        hashToSender[hash] = transaction.handle
        await transaction.delete()
        hashes.push(hash)
    }
    return hashes
}

export async function rawBulkSend(from: IAddress, recipients: string[], amount: string, tokenId: string, handle: string){
    const promises:Promise<IPendingTransactions>[] = []
    for(const recipient of recipients){
        promises.push(PendingTransaction.create({
            network: "VITE",
            address: from,
            toAddress: recipient,
            handle,
            amount,
            tokenId
        }))
    }
    return Promise.all(promises)
}

export async function sendVITE(seed: string, toAddress: string, amount: string, tokenId: string):Promise<string>{
    const keyPair = vite.wallet.deriveKeyPairByIndex(seed, 0)
    const fromAddress = vite.wallet.createAddressByPrivateKey(keyPair.privateKey)
    
    return await retryAsync(async (tries) => {
        try{
            const accountBlock = vite.accountBlock.createAccountBlock("send", {
                toAddress: toAddress,
                address: fromAddress.address,
                tokenId: tokenId,
                amount: amount
            })
            accountBlock.setProvider(wsProvider)
            .setPrivateKey(keyPair.privateKey)
            await accountBlock.autoSetPreviousAccountBlock()
            const quota = await wsProvider.request("contract_getQuotaByAccount", fromAddress.address)
            const availableQuota = new BigNumber(quota.currentQuota).div(21000)
            if(availableQuota.isLessThan(1)){
                //accountBlock.setProvider(powWSProvider)
                await accountBlock.PoW()
                accountBlock.setProvider(wsProvider)
                /*const difficulty = await accountBlock.getDifficulty()
                accountBlock.setDifficulty(difficulty)
                const threshold = (2**256/(1+1/parseInt(difficulty))).toString(16)
                const getNonceHash = vite.utils.blake2bHex(Buffer.concat([
                    Buffer.from(accountBlock.originalAddress, "hex"),
                    Buffer.from(accountBlock.previousHash, "hex")
                ]), null, 32)
                const work = await PoWManager.computeWork(getNonceHash, threshold)
                accountBlock.setNonce(Buffer.from(work, "hex").toString("base64"))*/
            }
            await accountBlock.sign()
        
            return (await accountBlock.send()).hash
        }catch(err){
            if(tries !== 2){
                await wait(20000)
            }
            throw err
        }
    }, 1)
}

export async function getBalances(address: string){
    const result = await wsProvider.request("ledger_getAccountInfoByAddress", address)
    // Just in case
    if(!result)throw new Error("No result for this address")
    const balances:{
        [tokenId: string]: string
    } = {
        [tokenIds.VITC]: "0"
    }
    for(const tokenId in result.balanceInfoMap){
        balances[tokenId] = result.balanceInfoMap[tokenId].balance
    }
    return balances
}

export async function searchStuckTransactions(){
    const addresses = await Address.find()
    for(const address of addresses){
        try{
            // eslint-disable-next-line no-constant-condition
            while(true){
                const shouldStop = await (async () => {
                    const blocks = await wsProvider.request(
                        "ledger_getUnreceivedBlocksByAddress",
                        address.address,
                        0,
                        10
                    )
                    if(blocks.length === 0)return true
                    for(const block of blocks){
                        if(skipBlocks.includes(block.hash))continue
                        skipBlocks.push(block.hash)
                
                        await receive(address, block)
                        skipBlocks.splice(skipBlocks.indexOf(block.hash), 1)
                    }
                    return false
                })()
                if(shouldStop)break
            }
        }catch(err){
            console.error(err)
        }
    }
}

(async () => {
    // Start of the code ! Time to receive as most transactions as possible !
    await Promise.all([
        searchStuckTransactions(),
        PendingTransaction.find()
        .populate("address")
        .exec()
        .then(processBulkTransactions)
    ])
    setInterval(searchStuckTransactions, 10*60*1000)
})()
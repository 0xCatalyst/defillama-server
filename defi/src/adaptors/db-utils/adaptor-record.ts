import { DynamoDB } from "aws-sdk"
import dynamodb from "../../utils/shared/dynamodb"
import { formatChain, formatChainKey } from "../utils/getAllChainsFromAdaptors"
import removeErrors from "../utils/removeErrors"
import { Item } from "./base"
import { ProtocolType } from "@defillama/dimension-adapters/adapters/types"
import { IJSON } from "../data/types"
import dynamoReservedKeywords from "./dynamo-reserved-keywords"

export enum AdaptorRecordType {
    dailyVolume = "dv",
    totalVolume = "tv",
    totalPremiumVolume = "tpv",
    totalNotionalVolume = "tnv",
    dailyPremiumVolume = "dpv",
    dailyNotionalVolume = "dnv",
    tokenIncentives = "ti",
    // fees & revenue
    dailyFees = "df",
    dailyRevenue = "dr",
    dailyUserFees = "duf",
    dailySupplySideRevenue = "dssr",
    dailyProtocolRevenue = "dpr",
    dailyHoldersRevenue = "dhr",
    dailyCreatorRevenue = "dcr",
    totalFees = "tf",
    totalRevenue = "tr",
    totalUserFees = "tuf",
    totalSupplySideRevenue = "tssr",
    totalProtocolRevenue = "tpr",
    totalHoldersRevenue = "thr",
    totalCreatorRevenue = "tcr"
}

export const AdaptorRecordTypeMap = Object.entries(AdaptorRecordType).reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {} as IJSON<AdaptorRecordType>)
export const AdaptorRecordTypeMapReverse = Object.entries(AdaptorRecordType).reduce((acc, [key, value]) => ({ ...acc, [value]: key }), {} as IJSON<string>)

export interface IRecordAdapterRecordChainData {
    [protocolVersion: string]: number | string | IJSON<string>,
}

export interface IRecordAdaptorRecordData {
    [chain: string]: IRecordAdapterRecordChainData | number
}

export interface RawRecordMap {
    [recordName: string]: IRecordAdaptorRecordData
}

export class AdaptorRecord extends Item {
    data: IRecordAdaptorRecordData
    type: AdaptorRecordType
    adaptorId: string
    timestamp: number
    protocolType: ProtocolType

    constructor(type: AdaptorRecordType, adaptorId: string, timestamp: number, data: IRecordAdaptorRecordData, protocolType: ProtocolType = ProtocolType.PROTOCOL) {
        super()
        this.data = data
        this.type = type
        this.adaptorId = adaptorId
        this.timestamp = timestamp
        this.protocolType = protocolType
    }

    static fromItem(item?: DynamoDB.AttributeMap): AdaptorRecord {
        if (!item) throw new Error("No item!")
        if (!item.PK || !item.SK) throw new Error("Bad item!")
        // PK=dv#{dex}#{id} TODO: set dex?
        // TODO: update dynamodb types with correct sdk
        const recordType = (item.PK as string).split("#")[0] as AdaptorRecordType
        const protocolType = (item.PK as string).split("#")[1] as ProtocolType
        const dexId = (item.PK as string).split("#")[2]
        const body = item as IRecordAdaptorRecordData
        const timestamp = +item.SK
        delete body.PK;
        delete body.SK;
        const clean_body = Object.entries(body).reduce((acc, [key, value]) => {
            acc[revertReservedKeyword(key)] = value
            return acc
        }, {} as IRecordAdaptorRecordData)
        return new AdaptorRecord(recordType, dexId, timestamp, clean_body, protocolType)
    }

    get pk(): string {
        if (this.type === AdaptorRecordType.dailyVolume || this.type === AdaptorRecordType.totalVolume)
            return `${this.type}#dex#${this.adaptorId}`
        return `${this.type}#${this.protocolType}#${this.adaptorId}`
    }

    get sk(): number {
        return this.timestamp
    }

    toItem(): Record<string, unknown> {
        return {
            ...this.keys(),
            ...this.data
        }
    }

    getCleanAdaptorRecord(chains?: string[]): AdaptorRecord | null {
        let data = this.data
        if (chains !== undefined && chains.length > 0) {
            //if (!this.data[chain] && !this.data[formatChainKey(chain)]) return null
            data = chains.reduce((acc, chain) => {
                acc[formatChainKey(chain)] = this.data[chain] ?? this.data[formatChainKey(chain)]
                return acc
            }, {} as IJSON<number | IRecordAdapterRecordChainData>)
        }
        const newDataNoErr = removeErrors(data)
        if (AdaptorRecord.isDataEmpty(newDataNoErr)) return null
        return new AdaptorRecord(this.type, this.adaptorId, this.timestamp, newDataNoErr)
    }

    static isDataEmpty(data: IRecordAdaptorRecordData) {
        return Object.keys(Object.entries(data).reduce((acc, [chain, value]) => {
            if (typeof value === 'number' || value === undefined) return acc
            const valueNew = Object.entries(value).reduce((ac, [prot, val]) => {
                if (!Number.isNaN(val))
                    ac[prot] = val
                return ac
            }, {} as IRecordAdapterRecordChainData)
            if (Object.keys(valueNew).length > 0)
                acc[chain] = valueNew
            return acc
        }, {} as IRecordAdaptorRecordData)).length === 0
    }
}

export const storeAdaptorRecord = async (adaptorRecord: AdaptorRecord, eventTimestamp: number): Promise<AdaptorRecord> => {
    if (Object.entries(adaptorRecord.data).length === 0) throw new Error(`${adaptorRecord.type}: Can't store empty adaptor record`)
    const currentRecord = await getAdaptorRecord(adaptorRecord.adaptorId, adaptorRecord.type, adaptorRecord.protocolType, "TIMESTAMP", adaptorRecord.timestamp).catch(() => console.info("No previous data found, writting new row..."))
    let currentData: IRecordAdaptorRecordData = {}
    if (currentRecord instanceof AdaptorRecord) currentData = currentRecord.data
    const obj2Store: IRecordAdaptorRecordData = {
        ...Object.entries(adaptorRecord.data).reduce((acc, [chain, data]) => {
            const currentChainValue = acc[chain]
            if (typeof data === 'number' || typeof currentChainValue === 'number') return acc
            const clean_chain = replaceReservedKeyword(chain)
            acc[clean_chain] = {
                ...currentChainValue,
                ...data
            }
            return acc
        }, currentData),
        eventTimestamp
    }
    try {
        console.log("Storing", adaptorRecord)
        await dynamodb.update({
            Key: adaptorRecord.keys(),
            UpdateExpression: createUpdateExpressionFromObj(obj2Store),
            ExpressionAttributeValues: createExpressionAttributeValuesFromObj(obj2Store)
        }) // Upsert like
        return adaptorRecord
    } catch (error) {
        throw error
    }
}

const normalizeSuffix = "_key"
function replaceReservedKeyword(key: string) {
    if (dynamoReservedKeywords.includes(key.toUpperCase())) return `${key}${normalizeSuffix}`
    return key
}
function revertReservedKeyword(key: string) {
    if (key.includes(normalizeSuffix))
        return key.slice(0, -normalizeSuffix.length)
    return key
}

function createUpdateExpressionFromObj(obj: IRecordAdaptorRecordData): string {
    return `set ${Object.keys(obj).map(field => `${field}=:${field}`).join(',')}`
}

function createExpressionAttributeValuesFromObj(obj: IRecordAdaptorRecordData): Record<string, unknown> {
    return Object.entries(obj).reduce((acc, [key, value]) => {
        return {
            ...acc,
            [`:${key}`]: value
        }
    }, {} as Record<string, unknown>)
}

export const getAdaptorRecord = async (adaptorId: string, type: AdaptorRecordType, protocolType?: ProtocolType, mode: "ALL" | "LAST" | "TIMESTAMP" = "ALL", timestamp?: number): Promise<AdaptorRecord[] | AdaptorRecord> => {
    // Creating dummy object to get the correct key
    const adaptorRecord = new AdaptorRecord(type, adaptorId, null!, null!, protocolType)
    let keyConditionExpression = "PK = :pk"
    const expressionAttributeValues: { [key: string]: any } = {
        ":pk": adaptorRecord.pk,
    }
    if (mode === 'TIMESTAMP') {
        expressionAttributeValues[":sk"] = timestamp
        keyConditionExpression = `${keyConditionExpression} and SK = :sk`
    }
    try {
        const resp = await dynamodb.query({
            // TODO: Change for upsert like
            KeyConditionExpression: keyConditionExpression,
            ExpressionAttributeValues: expressionAttributeValues,
            Limit: mode === "LAST" ? 1 : undefined,
            ScanIndexForward: mode === "LAST" ? false : true
        })
        if (!resp.Items || resp.Items.length === 0) throw Error(`No items found for ${adaptorRecord.pk}${timestamp ? ` at ${timestamp}` : ''}`)
        return mode === "LAST" || mode === 'TIMESTAMP' ? AdaptorRecord.fromItem(resp.Items[0]) : resp.Items.map(AdaptorRecord.fromItem)
    } catch (error) {
        throw error
    }
}

// REMOVES ALL VOLUMES, DO NOT USE!
export const removeAdaptorRecord = async (adaptorId: string, type: AdaptorRecordType, protocolType: ProtocolType): Promise<boolean> => {
    /* try {
        const allAdaptorRecords = await getAdaptorRecord(adaptorId, type, protocolType, "ALL")
        if (!(allAdaptorRecords instanceof Array)) throw new Error("Unexpected error deleting adaptor records")
        const cleanAdaptorRecs = allAdaptorRecords// .filter(v => v.timestamp * 1000 <= Date.UTC(2020, 8, 7))
        await Promise.all(cleanAdaptorRecs.map(adaptorRecord => removeAdaptorRecordQuery(adaptorRecord)))
        return true
    } catch (error) {
        console.log(error)
        return false
    } */
    console.log(adaptorId, type, protocolType)
    return Promise.resolve(false)
}

export const removeAdaptorRecordQuery = async (adaptorRecord: AdaptorRecord) => {
    console.log("Removing", adaptorRecord.keys())
    return dynamodb.delete({
        Key: adaptorRecord.keys(),
    })
}
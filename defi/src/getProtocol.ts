import { successResponse, wrap, IResponse, errorResponse, cache20MinResponse } from "./utils/shared";
import protocols from "./protocols/data";
import sluggify from "./utils/sluggify";
import { storeDataset, buildRedirect } from "./utils/s3";
import craftProtocol from "./utils/craftProtocol";
import parentProtocols from "./protocols/parentProtocols";
import craftParentProtocol from "./utils/craftParentProtocol";
import standardizeProtocolName from "./utils/standardizeProtocolName";

export async function craftProtocolResponse(
  rawProtocolName: string | undefined,
  useNewChainNames: boolean,
  useHourlyData: boolean,
  skipAggregatedTvl: boolean
) {
  const protocolName = rawProtocolName?.toLowerCase();

  const protocolData = protocols.find((prot) => sluggify(prot) === protocolName);

  if (!protocolData) {
    const parentProtocol = parentProtocols.find(
      (parent) => parent.name.toLowerCase() === standardizeProtocolName(protocolName)
    );

    if (!parentProtocol) {
      return errorResponse({
        message: "Protocol is not in our database",
      });
    }

    return craftParentProtocol(parentProtocol, useNewChainNames, useHourlyData, skipAggregatedTvl);
  }

  if (protocolData === undefined) {
    return errorResponse({
      message: "Protocol is not in our database",
    });
  }

  return craftProtocol(protocolData, useNewChainNames, useHourlyData, false, skipAggregatedTvl);
}

export async function wrapResponseOrRedirect(response: any) {
  const jsonData = JSON.stringify(response);
  const dataLength = Buffer.byteLength(jsonData, "utf8");

  if (process.env.stage !== "prod" || dataLength < 5.5e6) {
    return cache20MinResponse(response);
  } else {
    const filename = `protocol-${response.name}.json`;

    await storeDataset(filename, jsonData, "application/json");

    return buildRedirect(filename, 10 * 60);
  }
}

const handler = async (event: AWSLambda.APIGatewayEvent): Promise<IResponse> => {
  const response = await craftProtocolResponse(event.pathParameters?.protocol, false, false, false);

  return wrapResponseOrRedirect(response);
};

export default wrap(handler);

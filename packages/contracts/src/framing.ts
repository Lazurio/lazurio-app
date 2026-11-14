import type { DescMessage, MessageShape } from "@bufbuild/protobuf";
import { sizeDelimitedDecodeStream, sizeDelimitedEncode } from "@bufbuild/protobuf/wire";

// The one framing of the conversation between the main process and its helpers: each message is
// prefixed by its length as a varint, the size-delimited encoding that protobuf-es, Go's
// protodelim and Rust's prost implement alike (proto/lazurio/app/helper/v1/helper.proto).

export const encodeFrame = <Desc extends DescMessage>(
  schema: Desc,
  message: MessageShape<Desc>,
): Uint8Array => sizeDelimitedEncode(schema, message);

export const decodeFrames = <Desc extends DescMessage>(
  schema: Desc,
  chunks: AsyncIterable<Uint8Array>,
): AsyncIterableIterator<MessageShape<Desc>> => sizeDelimitedDecodeStream(schema, chunks);

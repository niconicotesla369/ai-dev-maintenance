export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
};

export type JsonRpcResponse =
  | {
    jsonrpc: '2.0';
    id: JsonRpcId;
    result: unknown;
  }
  | {
    jsonrpc: '2.0';
    id: JsonRpcId;
    error: {
      code: number;
      message: string;
    };
  };

export function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    result
  };
}

export function jsonRpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message
    }
  };
}

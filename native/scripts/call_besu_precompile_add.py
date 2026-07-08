#!/usr/bin/env python3
import json
import pathlib
import struct
import sys
import urllib.request


def main() -> int:
    if len(sys.argv) != 6:
        print(
            "usage: call_besu_precompile_add.py <rpc-url> <left.ct> <right.ct> <out.ct> <gas-hex>",
            file=sys.stderr,
        )
        return 2

    rpc_url, left_path, right_path, out_path, gas_hex = sys.argv[1:]
    left = pathlib.Path(left_path).read_bytes()
    right = pathlib.Path(right_path).read_bytes()

    request = bytearray([1, 1, 4, 0, 1, 2])
    for operand in (left, right):
        request += struct.pack(">I", len(operand))
        request += operand

    body = json.dumps(
        {
            "jsonrpc": "2.0",
            "method": "eth_call",
            "params": [
                {
                    "to": "0x0000000000000000000000000000000000000100",
                    "gas": gas_hex,
                    "data": "0x" + request.hex(),
                },
                "latest",
            ],
            "id": 42,
        }
    ).encode()

    http_request = urllib.request.Request(
        rpc_url, data=body, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(http_request, timeout=900) as response:
        payload = json.loads(response.read())

    if "error" in payload:
        raise RuntimeError(payload["error"])

    raw = bytes.fromhex(payload["result"][2:])
    if len(raw) < 8:
        raise RuntimeError(f"malformed response: {payload['result'][:80]}")
    if raw[0] != 0:
        raise RuntimeError(f"precompile status={raw[0]} response={payload['result'][:80]}")

    result_length = int.from_bytes(raw[4:8], "big")
    result = raw[8 : 8 + result_length]
    if len(result) != result_length:
        raise RuntimeError("truncated precompile result")

    pathlib.Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    pathlib.Path(out_path).write_bytes(result)
    print(f"result_bytes={len(result)}")
    print(f"result_path={out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

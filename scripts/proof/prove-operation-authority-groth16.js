process.argv.splice(2, 0, "operation-authority");
require("./groth16/prove");

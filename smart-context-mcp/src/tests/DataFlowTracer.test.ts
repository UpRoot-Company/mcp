import * as fs from "fs";
import * as path from "path";
import { AstManager } from "../ast/AstManager.js";
import { SkeletonGenerator } from "../ast/SkeletonGenerator.js";
import { SymbolIndex } from "../ast/SymbolIndex.js";
import { DataFlowTracer } from "../ast/DataFlowTracer.js";

describe("DataFlowTracer", () => {
    const testDir = path.join(process.cwd(), "src", "tests", "data_flow_test_env");

    const writeFile = (relativePath: string, content: string) => {
        const absPath = path.join(testDir, relativePath);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, content);
    };

    let symbolIndex: SymbolIndex;
    let tracer: DataFlowTracer;

    beforeAll(async () => {
        await AstManager.getInstance().init();
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
        fs.mkdirSync(testDir, { recursive: true });

        writeFile("flows/calc.ts", `export function transform(input: number) {
    let total = input;
    total = total + 2;
    logValue(total);
    return total;
}

function logValue(value: number) {
    console.log(value);
}
`);
    });

    afterAll(() => {
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    });

    beforeEach(() => {
        const generator = new SkeletonGenerator();
        symbolIndex = new SymbolIndex(testDir, generator, []);
        tracer = new DataFlowTracer(testDir, symbolIndex);
    });

    it("captures definition, assignment, call, and return steps", async () => {
        const absPath = path.join(testDir, "flows", "calc.ts");
        const result = await tracer.traceVariable("total", absPath, 3, 10);
        expect(result).not.toBeNull();
        if (!result) return;

        expect(result.orderedStepIds.length).toBe(4);
        const stepTypes = result.orderedStepIds.map(id => result.steps[id].stepType);
        expect(stepTypes).toEqual(["definition", "assignment", "call_argument", "return"]);

        const callStep = result.steps[result.orderedStepIds[2]];
        expect(callStep.metadata?.calleeName).toBe("logValue");
        expect(callStep.metadata?.argumentIndex).toBe(0);
        expect(result.truncated).toBe(false);
    });

    it("respects maxSteps and truncates when necessary", async () => {
        const absPath = path.join(testDir, "flows", "calc.ts");
        const result = await tracer.traceVariable("total", absPath, undefined, 2);
        expect(result).not.toBeNull();
        if (!result) return;

        expect(result.orderedStepIds.length).toBe(2);
        expect(result.truncated).toBe(true);
    });
});

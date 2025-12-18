import { AgentWorkflowGuidance, AGENT_WORKFLOW_PATTERNS } from '../engine/AgentPlaybook.js';

describe('AgentWorkflowGuidance', () => {
    it('should have all 7 stages in workflow', () => {
        const steps = AgentWorkflowGuidance.workflow.steps;
        expect(steps.length).toBe(7);
        expect(steps[0].name).toBe('Scout & Discover');
        expect(steps[6].name).toBe('Validate & Verify');
    });

    it('should have 5 recovery strategies', () => {
        const recovery = AgentWorkflowGuidance.recovery;
        expect(recovery.length).toBe(5);
        
        const expectedCodes = ['NO_MATCH', 'AMBIGUOUS_MATCH', 'HASH_MISMATCH', 'PARSE_ERROR', 'INDEX_STALE'];
        expectedCodes.forEach(code => {
            const strategy = recovery.find(r => r.code === code);
            expect(strategy).toBeDefined();
            expect(strategy?.action.toolName).toBeDefined();
        });
    });

    it('should provide valid tool suggestions for each step', () => {
        AgentWorkflowGuidance.workflow.steps.forEach(step => {
            if (step.tools) {
                expect(step.tools.length).toBeGreaterThan(0);
            }
            expect(step.description).toBeDefined();
        });
    });
});

describe('AGENT_WORKFLOW_PATTERNS', () => {
    it('should have finding-files pattern', () => {
        const pattern = AGENT_WORKFLOW_PATTERNS['finding-files'];
        expect(pattern).toBeDefined();
        expect(pattern.bestApproach[0].tool).toBe('search_project');
        expect(pattern.bestApproach[0].params.type).toBe('filename');
    });

    it('should have finding-symbols pattern', () => {
        const pattern = AGENT_WORKFLOW_PATTERNS['finding-symbols'];
        expect(pattern).toBeDefined();
        expect(pattern.bestApproach[0].tool).toBe('analyze_relationship');
    });

    it('should have recovery patterns', () => {
        const pattern = AGENT_WORKFLOW_PATTERNS['recovering-from-failures'];
        expect(pattern).toBeDefined();
        expect(pattern.bestApproach.length).toBeGreaterThan(0);
    });
});

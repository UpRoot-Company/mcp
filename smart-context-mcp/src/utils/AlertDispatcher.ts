import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { spawn } from 'child_process';
import { AdaptiveFlowAlertPayload } from './AdaptiveFlowReporter.js';

export interface AlertDispatcherOptions {
    rootPath: string;
    logDir?: string;
    webhookUrl?: string;
    command?: string;
    pagerDutyRoutingKey?: string;
    severity?: 'info' | 'warning' | 'error' | 'critical';
    channel?: string;
    label?: string;
}

export class AlertDispatcher {
    private readonly logDir: string;

    constructor(private readonly options: AlertDispatcherOptions) {
        this.logDir = options.logDir ?? path.join(options.rootPath, '.smart-context', 'logs');
    }

    async dispatch(payload: AdaptiveFlowAlertPayload): Promise<void> {
        const results = await Promise.allSettled([
            this.appendToLog(payload),
            this.sendWebhook(payload),
            this.sendPagerDuty(payload),
            this.runCommand(payload)
        ]);
        for (const result of results) {
            if (result.status === 'rejected') {
                console.warn('[AlertDispatcher] Failed to deliver alert:', result.reason);
            }
        }
    }

    private async appendToLog(payload: AdaptiveFlowAlertPayload): Promise<void> {
        const filePath = path.join(this.logDir, 'adaptive-flow-alerts.ndjson');
        await fs.promises.mkdir(this.logDir, { recursive: true });
        const entry = JSON.stringify({
            timestamp: new Date().toISOString(),
            channel: this.options.channel ?? 'adaptive-flow',
            severity: this.options.severity ?? 'warning',
            ...payload
        });
        await fs.promises.appendFile(filePath, entry + '\n');
    }

    private async sendWebhook(payload: AdaptiveFlowAlertPayload): Promise<void> {
        if (!this.options.webhookUrl) return;
        const body = {
            label: this.options.label ?? 'adaptive-flow',
            channel: this.options.channel,
            severity: this.options.severity ?? this.mapSeverity(payload.type),
            message: payload.message,
            metrics: payload.metrics,
            timestamp: new Date().toISOString()
        };
        await this.postJson(this.options.webhookUrl, body);
    }

    private async sendPagerDuty(payload: AdaptiveFlowAlertPayload): Promise<void> {
        if (!this.options.pagerDutyRoutingKey) return;
        const body = {
            routing_key: this.options.pagerDutyRoutingKey,
            event_action: 'trigger',
            payload: {
                summary: payload.message,
                source: 'smart-context-mcp',
                component: payload.type,
                severity: this.mapSeverity(payload.type),
                custom_details: payload.metrics
            }
        };
        await this.postJson('https://events.pagerduty.com/v2/enqueue', body);
    }

    private async runCommand(payload: AdaptiveFlowAlertPayload): Promise<void> {
        if (!this.options.command) return;
        await new Promise<void>((resolve, reject) => {
            const child = spawn(this.options.command!, {
                shell: true,
                stdio: ['pipe', 'inherit', 'inherit']
            });
            child.on('error', reject);
            child.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Alert command exited with code ${code}`));
                }
            });
            child.stdin?.end(JSON.stringify(payload));
        });
    }

    private async postJson(targetUrl: string, body: any): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            try {
                const payload = JSON.stringify(body);
                const parsed = new URL(targetUrl);
                const isHttps = parsed.protocol === 'https:';
                const options = {
                    hostname: parsed.hostname,
                    port: parsed.port ? Number(parsed.port) : (isHttps ? 443 : 80),
                    path: `${parsed.pathname}${parsed.search}`,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload)
                    }
                };
                const transport = isHttps ? https : http;
                const req = transport.request(options, (res) => {
                    res.on('data', () => undefined);
                    res.on('end', () => resolve());
                });
                req.on('error', reject);
                req.write(payload);
                req.end();
            } catch (error) {
                reject(error);
            }
        });
    }

    private mapSeverity(type: AdaptiveFlowAlertPayload['type']): 'info' | 'warning' | 'error' | 'critical' {
        if (type === 'ucg-memory') return 'error';
        if (type === 'l3-promotion-ratio') return 'warning';
        return 'warning';
    }
}

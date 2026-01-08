export type VisualizationType = 'line' | 'bar' | 'pie' | 'table' | 'metric' | 'json';

export interface StandardResponse<T> {
    meta: {
        tool: string;
        description: string;
        arguments: Record<string, any>;
        time: {
            start: string;
            end: string;
            interval?: string;
            previousStart?: string;
            previousEnd?: string;
        };
        visualization: {
            type: VisualizationType;
            title: string;
            description?: string;
            xAxisLabel?: string;
            yAxisLabel?: string;
        };
    };
    data: T;
}

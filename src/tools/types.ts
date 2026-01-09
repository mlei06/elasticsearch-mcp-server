export type VisualizationType = 'line' | 'bar' | 'pie' | 'table' | 'metric' | 'json';

export interface StandardResponse<T> {
    data: T;
    meta: {
        tool: string;
        description: string;
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
}

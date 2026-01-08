import { FIELD_CONSTANTS } from './field-constants.js';

export interface CommonFiltersOptions {
    startDate: string;
    endDate: string;
    subscription?: string;
    excludeTestVisits?: boolean; // Default true
    account?: string;
    group?: string;
}

export function buildCommonFilters(options: CommonFiltersOptions): any[] {
    const { startDate, endDate, subscription, account, group } = options;
    const excludeTestVisits = options.excludeTestVisits ?? true;

    const filters: any[] = [
        {
            range: {
                [FIELD_CONSTANTS.timeField]: {
                    gte: startDate,
                    lt: endDate,
                },
            },
        },
    ];

    if (excludeTestVisits) {
        filters.push({
            term: {
                [FIELD_CONSTANTS.testVisitField]: 'No',
            },
        });
    }

    if (subscription) {
        filters.push({
            term: {
                [FIELD_CONSTANTS.subscriptionField]: subscription,
            },
        });
    }

    if (account) {
        filters.push({
            term: {
                [FIELD_CONSTANTS.accountField]: account,
            },
        });
    }

    if (group) {
        filters.push({
            term: {
                [FIELD_CONSTANTS.groupField]: group,
            },
        });
    }

    return filters;
}

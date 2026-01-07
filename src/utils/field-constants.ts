/**
 * Shared field name constants for Elasticsearch queries
 * All tools should use these constants instead of hardcoding field names
 */
export const FIELD_CONSTANTS = {
  index: 'stats-*',
  timeField: 'createdtime',
  testVisitField: 'test_visit.keyword',
  subscriptionField: 'subscription.keyword',
  accountField: 'account.keyword',
  groupField: 'group.keyword',
  providerField: 'provider0.keyword',
  patientField: 'patient0.keyword',
  callDurationField: 'call_duration',
  providerRatingField: 'provider_rating',
  patientRatingField: 'patient_rating',
  meetingBasedField: 'meeting_based',
  providerPlatformField: 'provider0_platform.keyword',
  patientPlatformField: 'patient0_platform.keyword',
  providerPlatformVersionField: 'provider0_platform_version.keyword',
  patientPlatformVersionField: 'patient0_platform_version.keyword',
} as const;



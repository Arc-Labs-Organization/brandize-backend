// RevenueCat Entitlements matched to Quotas
const SUBSCRIPTION_TIERS = {
  free: {
    downloadLimit: 0,
    generateLimit: 0,
  },
  starter: {
    downloadLimit: 10,
    generateLimit: 10,
  },
  pro: {
    downloadLimit: 25,
    generateLimit: 25,
  },
  max: {
    downloadLimit: 50,
    generateLimit: 50,
  },
};

// Map RevenueCat Entitlement IDs (from dashboard) to our internal Tier Keys
const ENTITLEMENT_TO_TIER = {
  'starter': 'starter',
  'pro': 'pro',
  'max': 'max',
};

module.exports = {
  SUBSCRIPTION_TIERS,
  ENTITLEMENT_TO_TIER,
};

import chalk from 'chalk';
import { ColabClient } from '../colab/client.js';
import { SubscriptionTier } from '../colab/api.js';
import { createSpinner, isJsonMode, jsonResult } from '../output/json-output.js';

const TIER_LABEL: Record<SubscriptionTier, string> = {
  [SubscriptionTier.NONE]: 'Free',
  [SubscriptionTier.PRO]: 'Colab Pro',
  [SubscriptionTier.PRO_PLUS]: 'Colab Pro+',
};

export async function usageCommand(colabClient: ColabClient): Promise<void> {
  const spinner = createSpinner('Fetching usage info...').start();
  try {
    const info = await colabClient.getConsumptionUserInfo();
    spinner.stop();

    if (isJsonMode()) {
      const result: Record<string, unknown> = {
        command: 'usage',
        subscriptionTier: TIER_LABEL[info.subscriptionTier],
        consumptionRateHourly: info.consumptionRateHourly,
      };
      if (info.subscriptionTier !== SubscriptionTier.NONE) {
        result.paidComputeUnitsBalance = info.paidComputeUnitsBalance;
      } else if (info.freeCcuQuotaInfo) {
        result.freeCcuQuotaInfo = {
          remainingCcu: info.freeCcuQuotaInfo.remainingTokens / 1000,
          nextRefillDate: new Date(info.freeCcuQuotaInfo.nextRefillTimestampSec * 1000).toISOString(),
        };
      }
      jsonResult(result);
      return;
    }

    console.log(chalk.bold('\nColab Usage:'));
    console.log(`  Subscription:      ${chalk.cyan(TIER_LABEL[info.subscriptionTier])}`);
    console.log(`  Consumption rate:  ${chalk.yellow(info.consumptionRateHourly.toFixed(4))} CCU/hr`);

    if (info.subscriptionTier !== SubscriptionTier.NONE) {
      console.log(`  Paid CCU balance:  ${chalk.green(info.paidComputeUnitsBalance.toFixed(4))} CCU`);
    } else if (info.freeCcuQuotaInfo) {
      const remainingCcu = (info.freeCcuQuotaInfo.remainingTokens / 1000).toFixed(4);
      const refillDate = new Date(info.freeCcuQuotaInfo.nextRefillTimestampSec * 1000).toLocaleString();
      console.log(`  Free CCU remaining: ${chalk.green(remainingCcu)} CCU`);
      console.log(`  Next refill:        ${chalk.dim(refillDate)}`);
    }

    console.log('');
  } catch (err) {
    spinner.fail('Failed to fetch usage info');
    throw err;
  }
}

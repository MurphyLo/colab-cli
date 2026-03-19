import chalk from 'chalk';
import ora from 'ora';
import { ColabClient } from '../colab/client.js';
import { SubscriptionTier } from '../colab/api.js';

const TIER_LABEL: Record<SubscriptionTier, string> = {
  [SubscriptionTier.NONE]: 'Free',
  [SubscriptionTier.PRO]: 'Colab Pro',
  [SubscriptionTier.PRO_PLUS]: 'Colab Pro+',
};

export async function usageCommand(colabClient: ColabClient): Promise<void> {
  const spinner = ora('Fetching usage info...').start();
  try {
    const info = await colabClient.getConsumptionUserInfo();
    spinner.stop();

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

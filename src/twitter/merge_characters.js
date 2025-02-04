import TwitterPipeline from './TwitterPipeline.js';
import Logger from './Logger.js';
import inquirer from 'inquirer';
import chalk from 'chalk';

// Get arguments directly from process.argv
const [,, newCharacter, character1, character2] = process.argv;

async function promptForMergeOptions(sourceAccounts, availableTweets) {
  const answers = await inquirer.prompt([
    {
      type: 'number',
      name: 'tweetsPerAccount',
      message: 'How many top tweets to include from each account?',
      default: 50
    },
    {
      type: 'confirm',
      name: 'excludeRetweets',
      message: 'Exclude retweets?',
      default: true
    },
    {
      type: 'list',
      name: 'rankingMethod',
      message: 'How should tweets be ranked?',
      choices: ['Total engagement (likes + retweets)', 'Likes only', 'Retweets only'],
      default: 'Total engagement (likes + retweets)'
    }
  ]);

  return answers;
}

async function displayTweetSample(tweets, sourceAccounts) {
  // This function is no longer used in the new version
}

async function main() {
  const sourceAccounts = [character1, character2];

  if (!newCharacter || sourceAccounts.length < 2) {
    Logger.error("Usage: node merge_characters.js <new_name> <account1> <account2>");
    Logger.info("Example: node merge_characters.js alfacito cryptocito alfaketchum");
    process.exit(1);
  }

  try {
    const pipeline = new TwitterPipeline(newCharacter);
    
    // Get available tweet counts for each account
    const availableTweets = await Promise.all(sourceAccounts.map(async (account) => {
      try {
        const tweets = await pipeline.getTweetsForAccount(account);
        return tweets.length;
      } catch (error) {
        Logger.warn(`Could not get tweet count for @${account}: ${error.message}`);
        return 0;
      }
    }));

    // Show available tweets per account
    console.log('\n📊 Available Tweets:');
    sourceAccounts.forEach((account, i) => {
      console.log(chalk.cyan(`@${account}: ${availableTweets[i]} tweets`));
    });

    // Get merge options
    const options = await promptForMergeOptions(sourceAccounts, availableTweets);
    
    // Create merged character with options
    const mergedTweets = await pipeline.createMergedCharacter(sourceAccounts, {
      tweetsPerAccount: options.tweetsPerAccount,
      filterRetweets: !options.excludeRetweets,
      sortBy: options.rankingMethod
    });

    Logger.success('✨ Character merge completed successfully!');

  } catch (error) {
    Logger.error(`Failed to create merged character: ${error.message}`);
    process.exit(1);
  }
}

main(); 
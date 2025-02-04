import inquirer from "inquirer";
import chalk from "chalk";
import { format } from "date-fns";
import path from "path";
import fs from "fs/promises";
import { program } from 'commander';

// Imported Files
import Logger from "./Logger.js";
import DataOrganizer from "./DataOrganizer.js";
import TweetFilter from "./TweetFilter.js";

// agent-twitter-client
import { Scraper, SearchMode } from "agent-twitter-client";

// Puppeteer
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import AdblockerPlugin from "puppeteer-extra-plugin-adblocker";
import { Cluster } from "puppeteer-cluster";

// Configure puppeteer stealth once
puppeteer.use(StealthPlugin());
puppeteer.use(AdblockerPlugin({ blockTrackers: true }));

// Setup command line options to work with both formats:
// npm run twitter -- username --start-date 2024-01-01
// node src/twitter/index.js username --start-date 2024-01-01
program
  .allowExcessArguments(true)
  .argument('[username]', 'Twitter username to collect')
  .option('-s, --start-date <date>', 'Start date (YYYY-MM-DD)')
  .option('-e, --end-date <date>', 'End date (YYYY-MM-DD)')
  .parse(process.argv);

const options = program.opts();
const username = program.args[0];

class TwitterPipeline {
  constructor(username) {
    this.username = username;
    this.dataOrganizer = new DataOrganizer("pipeline", username);
    this.paths = this.dataOrganizer.getPaths();
    this.tweetFilter = new TweetFilter();

    // Update cookie path to be in top-level cookies directory
    this.paths.cookies = path.join(
      process.cwd(),
      'cookies',
      `${process.env.TWITTER_USERNAME}_cookies.json`
    );

    // Enhanced configuration with fallback handling
    this.config = {
      twitter: {
        maxTweets: parseInt(process.env.MAX_TWEETS) || 50000,
        maxRetries: parseInt(process.env.MAX_RETRIES) || 5,
        retryDelay: parseInt(process.env.RETRY_DELAY) || 5000,
        minDelayBetweenRequests: parseInt(process.env.MIN_DELAY) || 1000,
        maxDelayBetweenRequests: parseInt(process.env.MAX_DELAY) || 3000,
        rateLimitThreshold: 3, // Number of rate limits before considering fallback
      },
      fallback: {
        enabled: true,
        sessionDuration: 30 * 60 * 1000, // 30 minutes
        viewport: {
          width: 1366,
          height: 768,
          deviceScaleFactor: 1,
          hasTouch: false,
          isLandscape: true,
        },
      },
    };

    this.scraper = new Scraper();
    this.cluster = null;

    // Enhanced statistics tracking
    this.stats = {
      requestCount: 0,
      rateLimitHits: 0,
      retriesCount: 0,
      uniqueTweets: 0,
      fallbackCount: 0,
      startTime: Date.now(),
      oldestTweetDate: null,
      newestTweetDate: null,
      fallbackUsed: false,
    };
  }

  async initializeFallback() {
    if (!this.cluster) {
      this.cluster = await Cluster.launch({
        puppeteer,
        maxConcurrency: 1, // Single instance for consistency
        timeout: 30000,
        puppeteerOptions: {
          headless: "new",
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-blink-features=AutomationControlled",
          ],
        },
      });

      this.cluster.on("taskerror", async (err) => {
        Logger.warn(`Fallback error: ${err.message}`);
        this.stats.retriesCount++;
      });
    }
  }

  async setupFallbackPage(page) {
    await page.setViewport(this.config.fallback.viewport);

    // Basic evasion only - maintain consistency
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
  }

  async validateEnvironment() {
    Logger.startSpinner("Validating environment");
    const required = ["TWITTER_USERNAME", "TWITTER_PASSWORD"];
    const missing = required.filter((var_) => !process.env[var_]);

    if (missing.length > 0) {
      Logger.stopSpinner(false);
      Logger.error("Missing required environment variables:");
      missing.forEach((var_) => Logger.error(`- ${var_}`));
      console.log("\n📝 Create a .env file with your Twitter credentials:");
      console.log(`TWITTER_USERNAME=your_username`);
      console.log(`TWITTER_PASSWORD=your_password`);
      process.exit(1);
    }
    Logger.stopSpinner();
  }

async loadCookies() {
    try {
      if (await fs.access(this.paths.cookies).catch(() => false)) {
        const cookiesData = await fs.readFile(this.paths.cookies, 'utf-8');
        const cookies = JSON.parse(cookiesData);
        await this.scraper.setCookies(cookies);
        return true;
      }
    } catch (error) {
      Logger.warn(`Failed to load cookies: ${error.message}`);
    }
    return false;
}

async saveCookies() {
    try {
      const cookies = await this.scraper.getCookies();
      // Create cookies directory if it doesn't exist
      await fs.mkdir(path.dirname(this.paths.cookies), { recursive: true });
      await fs.writeFile(this.paths.cookies, JSON.stringify(cookies));
      Logger.success('Saved authentication cookies');
    } catch (error) {
      Logger.warn(`Failed to save cookies: ${error.message}`);
    }
}


  async initializeScraper() {
    Logger.startSpinner("Initializing Twitter scraper");
    let retryCount = 0;

    // Try loading cookies first
    if (await this.loadCookies()) {
      try {
        if (await this.scraper.isLoggedIn()) {
          Logger.success("✅ Successfully authenticated with saved cookies");
          Logger.stopSpinner();
          return true;
        }
      } catch (error) {
        Logger.warn("Saved cookies are invalid, attempting fresh login");
      }
    }

    // Verify all required credentials are present
    const username = process.env.TWITTER_USERNAME;
    const password = process.env.TWITTER_PASSWORD;
    const email = process.env.TWITTER_EMAIL;

    if (!username || !password || !email) {
      Logger.error("Missing required credentials. Need username, password, AND email");
      Logger.stopSpinner(false);
      return false;
    }

    // Attempt login with email verification
    while (retryCount < this.config.twitter.maxRetries) {
      try {
        // Add random delay before login attempt
        await this.randomDelay(5000, 10000);

        // Always use email in login attempt
        await this.scraper.login(username, password, email);

        // Verify login success
        const isLoggedIn = await this.scraper.isLoggedIn();
        if (isLoggedIn) {
          await this.saveCookies();
          Logger.success("✅ Successfully authenticated with Twitter");
          Logger.stopSpinner();
          return true;
        } else {
          throw new Error("Login verification failed");
        }

      } catch (error) {
        retryCount++;
        Logger.warn(
          `⚠️  Authentication attempt ${retryCount} failed: ${error.message}`
        );

        if (retryCount >= this.config.twitter.maxRetries) {
          Logger.stopSpinner(false);
          return false;
        }

        // Exponential backoff with jitter
        const baseDelay = this.config.twitter.retryDelay * Math.pow(2, retryCount - 1);
        const maxJitter = baseDelay * 0.2; // 20% jitter
        const jitter = Math.floor(Math.random() * maxJitter);
        await this.randomDelay(baseDelay + jitter, baseDelay + jitter + 5000);
      }
    }
    return false;
  }


  async randomDelay(min, max) {
    // Gaussian distribution for more natural delays
    const gaussianRand = () => {
      let rand = 0;
      for (let i = 0; i < 6; i++) rand += Math.random();
      return rand / 6;
    };

    const delay = Math.floor(min + gaussianRand() * (max - min));
    Logger.info(`Waiting ${(delay / 1000).toFixed(1)} seconds...`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  /*
  async initializeScraper() {
    Logger.startSpinner("Initializing Twitter scraper");
    let retryCount = 0;

    while (retryCount < this.config.twitter.maxRetries) {
      try {
        const username = process.env.TWITTER_USERNAME;
        const password = process.env.TWITTER_PASSWORD;

        if (!username || !password) {
          throw new Error("Twitter credentials not found");
        }

        // Try login with minimal parameters first
        await this.scraper.login(username, password);

        if (await this.scraper.isLoggedIn()) {
          Logger.success("✅ Successfully authenticated with Twitter");
          Logger.stopSpinner();
          return true;
        } else {
          throw new Error("Authentication failed");
        }
      } catch (error) {
        retryCount++;
        Logger.warn(
          `⚠️  Authentication attempt ${retryCount} failed: ${error.message}`
        );

        if (retryCount >= this.config.twitter.maxRetries) {
          Logger.stopSpinner(false);
          // Don't throw - allow fallback
          return false;
        }

        await this.randomDelay(
          this.config.twitter.retryDelay * retryCount,
          this.config.twitter.retryDelay * retryCount * 2
        );
      }
    }
    return false;
  }   */

  async randomDelay(min = null, max = null) {
    const minDelay = min || this.config.twitter.minDelayBetweenRequests;
    const maxDelay = max || this.config.twitter.maxDelayBetweenRequests;

    // Use gaussian distribution for more natural delays
    const gaussianRand = () => {
      let rand = 0;
      for (let i = 0; i < 6; i++) rand += Math.random();
      return rand / 6;
    };

    const delay = Math.floor(minDelay + gaussianRand() * (maxDelay - minDelay));
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  async handleRateLimit(retryCount = 1) {
    this.stats.rateLimitHits++;
    const baseDelay = 60000; // 1 minute
    const maxDelay = 15 * 60 * 1000; // 15 minutes

    // Exponential backoff with small jitter
    const exponentialDelay = baseDelay * Math.pow(2, retryCount - 1);
    const jitter = Math.random() * 0.1 * exponentialDelay; // 10% jitter
    const delay = Math.min(exponentialDelay + jitter, maxDelay);

    Logger.warn(
      `⚠️  Rate limit hit - waiting ${
        delay / 1000
      } seconds (attempt ${retryCount})`
    );

    await this.randomDelay(delay, delay * 1.1);
  }

  processTweetData(tweet) {
    try {
      if (!tweet || !tweet.id) return null;

      let timestamp = tweet.timestamp;
      if (!timestamp) {
        timestamp = tweet.timeParsed?.getTime();
      }

      if (!timestamp) return null;

      if (timestamp < 1e12) timestamp *= 1000;

      if (isNaN(timestamp) || timestamp <= 0) {
        Logger.warn(`⚠️  Invalid timestamp for tweet ${tweet.id}`);
        return null;
      }

      const tweetDate = new Date(timestamp);
      if (
        !this.stats.oldestTweetDate ||
        tweetDate < this.stats.oldestTweetDate
      ) {
        this.stats.oldestTweetDate = tweetDate;
      }
      if (
        !this.stats.newestTweetDate ||
        tweetDate > this.stats.newestTweetDate
      ) {
        this.stats.newestTweetDate = tweetDate;
      }

      return {
        id: tweet.id,
        text: tweet.text,
        username: tweet.username || this.username,
        timestamp,
        createdAt: new Date(timestamp).toISOString(),
        isReply: Boolean(tweet.isReply),
        isRetweet: Boolean(tweet.isRetweet),
        likes: tweet.likes || 0,
        retweetCount: tweet.retweets || 0,
        replies: tweet.replies || 0,
        photos: tweet.photos || [],
        videos: tweet.videos || [],
        urls: tweet.urls || [],
        permanentUrl: tweet.permanentUrl,
        quotedStatusId: tweet.quotedStatusId,
        inReplyToStatusId: tweet.inReplyToStatusId,
        hashtags: tweet.hashtags || [],
      };
    } catch (error) {
      Logger.warn(`⚠️  Error processing tweet ${tweet?.id}: ${error.message}`);
      return null;
    }
  }

  async collectWithFallback(searchQuery) {
    if (!this.cluster) {
      await this.initializeFallback();
    }

    const tweets = new Set();
    let sessionStartTime = Date.now();

    const fallbackTask = async ({ page }) => {
      await this.setupFallbackPage(page);

      try {
        // Login with minimal interaction
        await page.goto("https://twitter.com/login", {
          waitUntil: "networkidle0",
          timeout: 30000,
        });

        await page.type(
          'input[autocomplete="username"]',
          process.env.TWITTER_USERNAME
        );
        await this.randomDelay(500, 1000);
        await page.click('div[role="button"]:not([aria-label])');
        await this.randomDelay(500, 1000);
        await page.type('input[type="password"]', process.env.TWITTER_PASSWORD);
        await this.randomDelay(500, 1000);
        await page.click('div[role="button"][data-testid="LoginButton"]');
        await page.waitForNavigation({ waitUntil: "networkidle0" });

        // Go directly to search
        await page.goto(
          `https://twitter.com/search?q=${encodeURIComponent(
            searchQuery
          )}&f=live`
        );
        await this.randomDelay(1000, 2000);

        let lastTweetCount = 0;
        let unchangedCount = 0;

        while (
          unchangedCount < 3 &&
          Date.now() - sessionStartTime < this.config.fallback.sessionDuration
        ) {
          await page.evaluate(() => {
            window.scrollBy(0, 500);
          });

          await this.randomDelay(1000, 2000);

          const newTweets = await page.evaluate(() => {
            const tweetElements = Array.from(
              document.querySelectorAll('article[data-testid="tweet"]')
            );
            return tweetElements
              .map((tweet) => {
                try {
                  return {
                    id: tweet.getAttribute("data-tweet-id"),
                    text: tweet.querySelector("div[lang]")?.textContent || "",
                    timestamp: tweet
                      .querySelector("time")
                      ?.getAttribute("datetime"),
                    metrics: Array.from(
                      tweet.querySelectorAll('span[data-testid$="count"]')
                    ).map((m) => m.textContent),
                  };
                } catch (e) {
                  return null;
                }
              })
              .filter((t) => t && t.id);
          });

          for (const tweet of newTweets) {
            if (!tweets.has(tweet.id)) {
              tweets.add(tweet);
              this.stats.fallbackCount++;
            }
          }

          if (tweets.size === lastTweetCount) {
            unchangedCount++;
          } else {
            unchangedCount = 0;
            lastTweetCount = tweets.size;
          }
        }
      } catch (error) {
        Logger.warn(`Fallback collection error: ${error.message}`);
        throw error;
      }
    };

    await this.cluster.task(fallbackTask);
    await this.cluster.queue({});

    return Array.from(tweets);
  }

  async collectTweets(scraper) {
    try {
      const options = program.opts();
      const { startDate, endDate } = options;

      if (startDate && endDate) {
        Logger.info(`\n🗓️  Filtering tweets between ${startDate} and ${endDate}`);
      }

      const profile = await scraper.getProfile(this.username);
      const totalExpectedTweets = profile.tweetsCount;

      Logger.info(
        `📊 Found ${chalk.bold(
          totalExpectedTweets.toLocaleString()
        )} total tweets for @${this.username}`
      );

      const allTweets = new Map();
      let previousCount = 0;
      let stagnantBatches = 0;
      const MAX_STAGNANT_BATCHES = 2;

      // Rest of your existing collection logic...
      try {
        const searchResults = scraper.searchTweets(
          `from:${this.username}`,
          this.config.twitter.maxTweets,
          SearchMode.Latest
        );

        for await (const tweet of searchResults) {
          if (tweet && !allTweets.has(tweet.id)) {
            const processedTweet = this.processTweetData(tweet);
            
            // Add date filtering here
            if (processedTweet) {
              const tweetDate = new Date(processedTweet.timestamp);
              if (startDate && endDate) {
                if (tweetDate >= new Date(startDate) && tweetDate <= new Date(endDate)) {
                  allTweets.set(tweet.id, processedTweet);
                }
              } else {
                allTweets.set(tweet.id, processedTweet);
              }

              // Rest of your existing progress logging...
            }
          }
        }
      } catch (error) {
        // Your existing error handling...
      }

      return Array.from(allTweets.values());
    } catch (error) {
      Logger.error(`Failed to collect tweets: ${error.message}`);
      throw error;
    }
  }

  async showSampleTweets(tweets) {
    const { showSample } = await inquirer.prompt([
      {
        type: "confirm",
        name: "showSample",
        message: "Would you like to see a sample of collected tweets?",
        default: true,
      },
    ]);

    if (showSample) {
      Logger.info("\n🌟 Sample Tweets (Most Engaging):");

      const sortedTweets = tweets
        .filter((tweet) => !tweet.isRetweet)
        .sort((a, b) => b.likes + b.retweetCount - (a.likes + a.retweetCount))
        .slice(0, 5);

      sortedTweets.forEach((tweet, i) => {
        console.log(
          chalk.cyan(
            `\n${i + 1}. [${format(new Date(tweet.timestamp), "yyyy-MM-dd")}]`
          )
        );
        console.log(chalk.white(tweet.text));
        console.log(
          chalk.gray(
            `❤️ ${tweet.likes.toLocaleString()} | 🔄 ${tweet.retweetCount.toLocaleString()} | 💬 ${tweet.replies.toLocaleString()}`
          )
        );
        console.log(chalk.gray(`🔗 ${tweet.permanentUrl}`));
      });
    }
  }

  async getProfile() {
    const profile = await this.scraper.getProfile(this.username);
    return profile;
  }

  async mergeCharacters(otherAccounts) {
    Logger.info("\n🔄 Starting Character Merge Process");
    
    const mergedTweets = new Map();
    const mergedStats = {
      totalTweets: 0,
      accountBreakdown: {},
      dateRange: {
        oldest: null,
        newest: null
      }
    };

    // First add tweets from primary account
    const primaryTweets = await this.dataOrganizer.loadTweets();
    primaryTweets.forEach(tweet => {
      mergedTweets.set(tweet.id, tweet);
      mergedStats.totalTweets++;
      mergedStats.accountBreakdown[this.username] = (mergedStats.accountBreakdown[this.username] || 0) + 1;
      
      const tweetDate = new Date(tweet.timestamp);
      if (!mergedStats.dateRange.oldest || tweetDate < mergedStats.dateRange.oldest) {
        mergedStats.dateRange.oldest = tweetDate;
      }
      if (!mergedStats.dateRange.newest || tweetDate > mergedStats.dateRange.newest) {
        mergedStats.dateRange.newest = tweetDate;
      }
    });

    // Merge tweets from other accounts
    for (const account of otherAccounts) {
      Logger.info(`📥 Merging tweets from @${account}...`);
      
      const accountOrganizer = new DataOrganizer("pipeline", account);
      try {
        const accountTweets = await accountOrganizer.loadTweets();
        
        accountTweets.forEach(tweet => {
          if (!mergedTweets.has(tweet.id)) {
            mergedTweets.set(tweet.id, tweet);
            mergedStats.totalTweets++;
            mergedStats.accountBreakdown[account] = (mergedStats.accountBreakdown[account] || 0) + 1;
            
            const tweetDate = new Date(tweet.timestamp);
            if (!mergedStats.dateRange.oldest || tweetDate < mergedStats.dateRange.oldest) {
              mergedStats.dateRange.oldest = tweetDate;
            }
            if (!mergedStats.dateRange.newest || tweetDate > mergedStats.dateRange.newest) {
              mergedStats.dateRange.newest = tweetDate;
            }
          }
        });
      } catch (error) {
        Logger.warn(`⚠️ Failed to merge tweets from @${account}: ${error.message}`);
      }
    }

    // Save merged character data
    const mergedDir = path.join(this.dataOrganizer.baseDir, 'merged');
    await fs.mkdir(mergedDir, { recursive: true });
    
    // Save raw merged tweets
    const mergedArray = Array.from(mergedTweets.values());
    await fs.writeFile(
      path.join(mergedDir, 'merged_tweets.json'),
      JSON.stringify(mergedArray, null, 2)
    );

    // Create merged fine-tuning data
    const fineTuningData = mergedArray
      .filter(tweet => !tweet.isRetweet && tweet.text.length > 0)
      .map(tweet => ({ text: tweet.text }));
    
    await fs.writeFile(
      path.join(mergedDir, 'merged_finetuning.jsonl'),
      fineTuningData.map(entry => JSON.stringify(entry)).join('\n')
    );

    // Save merge statistics
    const mergeStats = {
      timestamp: new Date().toISOString(),
      accounts: [this.username, ...otherAccounts],
      totalTweets: mergedStats.totalTweets,
      accountBreakdown: mergedStats.accountBreakdown,
      dateRange: {
        start: mergedStats.dateRange.oldest.toISOString(),
        end: mergedStats.dateRange.newest.toISOString()
      }
    };

    await fs.writeFile(
      path.join(mergedDir, 'merge_stats.json'),
      JSON.stringify(mergeStats, null, 2)
    );

    // Display merge results
    Logger.success("\n✨ Character Merge Complete!");
    Logger.stats("📊 Merge Results", {
      "Total Tweets": mergedStats.totalTweets.toLocaleString(),
      "Date Range": `${mergeStats.dateRange.start.split('T')[0]} to ${mergeStats.dateRange.end.split('T')[0]}`,
      "Accounts Merged": Object.entries(mergedStats.accountBreakdown)
        .map(([acc, count]) => `@${acc}: ${count.toLocaleString()} tweets`)
        .join('\n              '),
      "Storage Location": chalk.gray(mergedDir)
    });

    return mergeStats;
  }

  async getTweetsForAccount(account) {
    try {
      // Get the latest date folder for this account
      const accountPath = path.join(process.cwd(), 'pipeline', account);
      const dates = await fs.readdir(accountPath);
      const latestDate = dates.sort().reverse()[0];
      
      // Read tweets from the raw tweets.json file
      const tweetsPath = path.join(accountPath, latestDate, 'raw', 'tweets.json');
      const rawData = await fs.readFile(tweetsPath, 'utf-8');
      return JSON.parse(rawData);
    } catch (error) {
      Logger.warn(`Failed to load tweets for @${account}: ${error.message}`);
      return [];
    }
  }

  async combineCharacterStats(sourceAccounts, targetDate) {
    Logger.info(`Combining stats for date: ${targetDate}`);
    
    const combinedStats = {
      engagement: { total: 0, average: 0 },
      topics: {},
      sentiment: { positive: 0, neutral: 0, negative: 0 },
      posting_times: [],
      hashtags: {},
      mentions: {}
    };

    let accountsProcessed = 0;

    for (const account of sourceAccounts) {
      try {
        const statsPath = path.join(process.cwd(), 'pipeline', account, targetDate, 'analytics', 'stats.json');
        Logger.info(`Reading stats from: ${statsPath}`);
        
        const rawStats = await fs.readFile(statsPath, 'utf-8');
        const stats = JSON.parse(rawStats);

        // Combine engagement
        if (stats.engagement && typeof stats.engagement.total === 'number') {
          combinedStats.engagement.total += stats.engagement.total;
        }

        // Combine topics
        if (stats.topics) {
          Object.entries(stats.topics).forEach(([topic, count]) => {
            combinedStats.topics[topic] = (combinedStats.topics[topic] || 0) + count;
          });
        }

        // Combine sentiment
        if (stats.sentiment) {
          Object.keys(combinedStats.sentiment).forEach(key => {
            if (typeof stats.sentiment[key] === 'number') {
              combinedStats.sentiment[key] += stats.sentiment[key];
            }
          });
        }

        // Combine posting times
        if (Array.isArray(stats.posting_times)) {
          combinedStats.posting_times.push(...stats.posting_times);
        }

        // Combine hashtags
        if (stats.hashtags) {
          Object.entries(stats.hashtags).forEach(([tag, count]) => {
            combinedStats.hashtags[tag] = (combinedStats.hashtags[tag] || 0) + count;
          });
        }

        // Combine mentions
        if (stats.mentions) {
          Object.entries(stats.mentions).forEach(([mention, count]) => {
            combinedStats.mentions[mention] = (combinedStats.mentions[mention] || 0) + count;
          });
        }

        accountsProcessed++;
      } catch (error) {
        Logger.warn(`Could not read stats for @${account}: ${error.message}`);
      }
    }

    // Calculate average engagement if we have data
    if (accountsProcessed > 0 && combinedStats.engagement.total !== null) {
      combinedStats.engagement.average = combinedStats.engagement.total / accountsProcessed;
    }

    // Save combined stats
    const targetStatsPath = path.join(process.cwd(), 'pipeline', this.username, targetDate, 'analytics', 'stats.json');
    Logger.info(`Saving combined stats to: ${targetStatsPath}`);
    await fs.writeFile(targetStatsPath, JSON.stringify(combinedStats, null, 2));

    return combinedStats;
  }

  async getLatestDateForAccount(account) {
    try {
      const accountPath = path.join(process.cwd(), 'pipeline', account);
      const dates = await fs.readdir(accountPath);
      return dates.sort().reverse()[0]; // Get most recent date
    } catch (error) {
      Logger.warn(`Could not get latest date for @${account}: ${error.message}`);
      return null;
    }
  }

  async generateStatsFromMergedTweets(tweets) {
    const stats = {
      totalTweets: tweets.length,
      directTweets: tweets.filter(t => !t.isReply && !t.isRetweet).length,
      replies: tweets.filter(t => t.isReply).length,
      retweets: tweets.filter(t => t.isRetweet).length,
      engagement: {
        totalLikes: tweets.reduce((sum, t) => sum + (t.likes || 0), 0),
        totalRetweetCount: tweets.reduce((sum, t) => sum + (t.retweetCount || 0), 0),
        totalReplies: tweets.reduce((sum, t) => sum + (t.replyCount || 0), 0),
        averageLikes: (tweets.reduce((sum, t) => sum + (t.likes || 0), 0) / tweets.length).toFixed(2),
        topTweets: tweets
          .sort((a, b) => (b.likes || 0) - (a.likes || 0))
          .slice(0, 5)
          .map(t => ({
            id: t.id,
            text: t.text.slice(0, 100), // Truncate for display
            likes: t.likes,
            retweetCount: t.retweetCount,
            url: t.url
          }))
      },
      timeRange: {
        start: new Date(Math.min(...tweets.map(t => new Date(t.timestamp)))).toISOString().split('T')[0],
        end: new Date(Math.max(...tweets.map(t => new Date(t.timestamp)))).toISOString().split('T')[0]
      },
      contentTypes: {
        withImages: tweets.filter(t => t.images?.length > 0).length,
        withVideos: tweets.filter(t => t.videos?.length > 0).length,
        withLinks: tweets.filter(t => t.text.includes('http')).length,
        textOnly: tweets.filter(t => !t.images?.length && !t.videos?.length && !t.text.includes('http')).length
      }
    };

    return stats;
  }

  async createMergedCharacter(sourceAccounts, options = {}) {
    const {
      tweetsPerAccount = 50,
      filterRetweets = true,
      sortBy = 'total'
    } = options;

    Logger.info("\n✨ Creating New Merged Character");
    
    // Get the latest date from source accounts
    const dates = await Promise.all(sourceAccounts.map(account => this.getLatestDateForAccount(account)));
    const validDates = dates.filter(date => date !== null);
    
    if (validDates.length === 0) {
      throw new Error('No valid dates found in source accounts');
    }
    
    // Use the most recent date among all source accounts
    const targetDate = validDates.sort().reverse()[0];
    Logger.info(`Using target date: ${targetDate}`);

    const mergedTweets = new Map();
    const mergedStats = {
      totalTweets: 0,
      accountBreakdown: {},
      dateRange: { oldest: null, newest: null }
    };

    // Process each source account
    for (const account of sourceAccounts) {
      Logger.info(`📥 Processing top tweets from @${account}...`);
      
      try {
        const accountTweets = await this.getTweetsForAccount(account);
        Logger.info(`Found ${accountTweets.length} tweets from @${account}`);

        // Filter and sort tweets based on options
        let filteredTweets = accountTweets;
        if (filterRetweets) {
          filteredTweets = filteredTweets.filter(tweet => !tweet.isRetweet);
        }

        const sortedTweets = filteredTweets.sort((a, b) => {
          switch (sortBy) {
            case 'likes':
              return b.likes - a.likes;
            case 'retweets':
              return b.retweetCount - a.retweetCount;
            case 'date':
              return new Date(b.timestamp) - new Date(a.timestamp);
            case 'total':
            default:
              return (b.likes + b.retweetCount) - (a.likes + a.retweetCount);
          }
        });

        const topTweets = sortedTweets.slice(0, tweetsPerAccount);
        Logger.info(`Selected top ${topTweets.length} tweets from @${account}`);

        topTweets.forEach(tweet => {
          mergedTweets.set(tweet.id, tweet);
          mergedStats.totalTweets++;
          mergedStats.accountBreakdown[account] = (mergedStats.accountBreakdown[account] || 0) + 1;
          
          const tweetDate = new Date(tweet.timestamp);
          if (!mergedStats.dateRange.oldest || tweetDate < mergedStats.dateRange.oldest) {
            mergedStats.dateRange.oldest = tweetDate;
          }
          if (!mergedStats.dateRange.newest || tweetDate > mergedStats.dateRange.newest) {
            mergedStats.dateRange.newest = tweetDate;
          }
        });
      } catch (error) {
        Logger.warn(`⚠️ Failed to process tweets from @${account}: ${error.message}`);
      }
    }

    // Combine stats using the determined target date
    await this.combineCharacterStats(sourceAccounts, targetDate);

    // Create directories with dynamic date
    const processedPath = path.join(process.cwd(), 'pipeline', this.username, targetDate, 'processed');
    const rawPath = path.join(process.cwd(), 'pipeline', this.username, targetDate, 'raw');
    const analyticsPath = path.join(process.cwd(), 'pipeline', this.username, targetDate, 'analytics');

    // Save merged tweets
    const mergedArray = Array.from(mergedTweets.values());
    await fs.writeFile(
      path.join(rawPath, 'tweets.json'),
      JSON.stringify(mergedArray, null, 2)
    );

    // Generate fresh stats from merged tweets
    const stats = await this.generateStatsFromMergedTweets(mergedArray);
    
    // Save stats
    await fs.writeFile(
      path.join(analyticsPath, 'stats.json'),
      JSON.stringify(stats, null, 2)
    );

    // Create fine-tuning data
    const fineTuningData = mergedArray
      .map(tweet => ({ text: tweet.text }));
    
    await fs.writeFile(
      path.join(processedPath, 'finetuning.jsonl'),
      fineTuningData.map(entry => JSON.stringify(entry)).join('\n')
    );

    // Save merge metadata
    const mergeStats = {
      timestamp: new Date().toISOString(),
      sourceAccounts: sourceAccounts,
      tweetsPerAccount,
      totalTweets: mergedStats.totalTweets,
      accountBreakdown: mergedStats.accountBreakdown,
      dateRange: {
        start: mergedStats.dateRange.oldest?.toISOString(),
        end: mergedStats.dateRange.newest?.toISOString()
      }
    };

    await fs.writeFile(
      path.join(rawPath, 'merge_stats.json'),
      JSON.stringify(mergeStats, null, 2)
    );

    // Display results
    Logger.success("\n✨ New Character Created!");
    Logger.stats("📊 Character Stats", {
      "Character Name": `@${this.username}`,
      "Source Accounts": sourceAccounts.join(', '),
      "Total Tweets": mergedStats.totalTweets.toLocaleString(),
      "Tweets per Account": Object.entries(mergedStats.accountBreakdown)
        .map(([acc, count]) => `@${acc}: ${count.toLocaleString()} tweets`)
        .join('\n                 '),
      "Date Range": mergeStats.dateRange.start ? 
        `${mergeStats.dateRange.start.split('T')[0]} to ${mergeStats.dateRange.end.split('T')[0]}` :
        'No tweets found',
      "Storage Location": chalk.gray(processedPath)
    });

    return mergeStats;
  }

  async run() {
    const startTime = Date.now();

    console.log("\n" + chalk.bold.blue("🐦 Twitter Data Collection Pipeline"));
    console.log(
      chalk.bold(`Target Account: ${chalk.cyan("@" + this.username)}\n`)
    );

    try {
      await this.validateEnvironment();

      // Initialize main scraper
      const scraperInitialized = await this.initializeScraper();
      if (!scraperInitialized && !this.config.fallback.enabled) {
        throw new Error(
          "Failed to initialize scraper and fallback is disabled"
        );
      }

      // Start collection
      Logger.startSpinner(`Collecting tweets from @${this.username}`);
      const allTweets = await this.collectTweets(this.scraper);
      Logger.stopSpinner();

      if (allTweets.length === 0) {
        Logger.warn("⚠️  No tweets collected");
        return;
      }

      // Save collected data
      Logger.startSpinner("Processing and saving data");
      const analytics = await this.dataOrganizer.saveTweets(allTweets);
      Logger.stopSpinner();

      // Calculate final statistics
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      const tweetsPerMinute = (allTweets.length / (duration / 60)).toFixed(1);
      const successRate = (
        (allTweets.length /
          (this.stats.requestCount + this.stats.fallbackCount)) *
        100
      ).toFixed(1);

      // Display final results
      Logger.stats("📈 Collection Results", {
        "Total Tweets": allTweets.length.toLocaleString(),
        "Original Tweets": analytics.directTweets.toLocaleString(),
        Replies: analytics.replies.toLocaleString(),
        Retweets: analytics.retweets.toLocaleString(),
        "Date Range": `${analytics.timeRange.start} to ${analytics.timeRange.end}`,
        Runtime: `${duration} seconds`,
        "Collection Rate": `${tweetsPerMinute} tweets/minute`,
        "Success Rate": `${successRate}%`,
        "Rate Limit Hits": this.stats.rateLimitHits.toLocaleString(),
        "Fallback Collections": this.stats.fallbackCount.toLocaleString(),
        "Storage Location": chalk.gray(this.dataOrganizer.baseDir),
      });

      // Content type breakdown
      Logger.info("\n📊 Content Type Breakdown:");
      console.log(
        chalk.cyan(
          `• Text Only: ${analytics.contentTypes.textOnly.toLocaleString()}`
        )
      );
      console.log(
        chalk.cyan(
          `• With Images: ${analytics.contentTypes.withImages.toLocaleString()}`
        )
      );
      console.log(
        chalk.cyan(
          `• With Videos: ${analytics.contentTypes.withVideos.toLocaleString()}`
        )
      );
      console.log(
        chalk.cyan(
          `• With Links: ${analytics.contentTypes.withLinks.toLocaleString()}`
        )
      );

      // Engagement statistics
      Logger.info("\n💫 Engagement Statistics:");
      console.log(
        chalk.cyan(
          `• Total Likes: ${analytics.engagement.totalLikes.toLocaleString()}`
        )
      );
      console.log(
        chalk.cyan(
          `• Total Retweets: ${analytics.engagement.totalRetweetCount.toLocaleString()}`
        )
      );
      console.log(
        chalk.cyan(
          `• Total Replies: ${analytics.engagement.totalReplies.toLocaleString()}`
        )
      );
      console.log(
        chalk.cyan(`• Average Likes: ${analytics.engagement.averageLikes}`)
      );

      // Collection method breakdown
      if (this.stats.fallbackUsed) {
        Logger.info("\n🔄 Collection Method Breakdown:");
        console.log(
          chalk.cyan(
            `• Primary Collection: ${(
              allTweets.length - this.stats.fallbackCount
            ).toLocaleString()}`
          )
        );
        console.log(
          chalk.cyan(
            `• Fallback Collection: ${this.stats.fallbackCount.toLocaleString()}`
          )
        );
      }

      // Show sample tweets
      await this.showSampleTweets(allTweets);

      // Cleanup
      await this.cleanup();

      return analytics;
    } catch (error) {
      Logger.error(`Pipeline failed: ${error.message}`);
      await this.cleanup();
      throw error;
    }
  }

  async cleanup() {
    try {
      // Cleanup main scraper
      if (this.scraper) {
        await this.scraper.logout();
        Logger.success("🔒 Logged out of primary system");
      }

      // Cleanup fallback system
      if (this.cluster) {
        await this.cluster.close();
        Logger.success("🔒 Cleaned up fallback system");
      }

      await this.saveProgress(null, null, this.stats.uniqueTweets, {
        completed: true,
        endTime: new Date().toISOString(),
        fallbackUsed: this.stats.fallbackUsed,
        fallbackCount: this.stats.fallbackCount,
        rateLimitHits: this.stats.rateLimitHits,
      });

      Logger.success("✨ Cleanup complete");
    } catch (error) {
      Logger.warn(`⚠️  Cleanup error: ${error.message}`);
      await this.saveProgress(null, null, this.stats.uniqueTweets, {
        completed: true,
        endTime: new Date().toISOString(),
        error: error.message,
      });
    }
  }

  async logError(error, context = {}) {
    const errorLog = {
      timestamp: new Date().toISOString(),
      error: {
        message: error.message,
        stack: error.stack,
      },
      context: {
        ...context,
        username: this.username,
        sessionDuration: Date.now() - this.stats.startTime,
        rateLimitHits: this.stats.rateLimitHits,
        fallbackUsed: this.stats.fallbackUsed,
        fallbackCount: this.stats.fallbackCount,
      },
      stats: this.stats,
      config: {
        delays: {
          min: this.config.twitter.minDelayBetweenRequests,
          max: this.config.twitter.maxDelayBetweenRequests,
        },
        retries: this.config.twitter.maxRetries,
        fallback: {
          enabled: this.config.fallback.enabled,
          sessionDuration: this.config.fallback.sessionDuration,
        },
      },
    };

    const errorLogPath = path.join(
      this.dataOrganizer.baseDir,
      "meta",
      "error_log.json"
    );

    try {
      let existingLogs = [];
      try {
        const existing = await fs.readFile(errorLogPath, "utf-8");
        existingLogs = JSON.parse(existing);
      } catch {
        // File doesn't exist yet
      }

      existingLogs.push(errorLog);

      // Keep only recent errors
      if (existingLogs.length > 100) {
        existingLogs = existingLogs.slice(-100);
      }

      await fs.writeFile(errorLogPath, JSON.stringify(existingLogs, null, 2));
    } catch (logError) {
      Logger.error(`Failed to save error log: ${logError.message}`);
    }
  }

  async saveProgress(startDate, endDate, totalTweets, progress) {
    const progressPath = path.join(this.dataOrganizer.baseDir, 'meta', 'progress.json');
    let existingProgress = {};

    try {
      const existing = await fs.readFile(progressPath, 'utf-8');
      existingProgress = JSON.parse(existing);
    } catch {
      // File doesn't exist yet
    }

    existingProgress.progress = progress;
    existingProgress.totalTweets = totalTweets;
    existingProgress.startDate = startDate;
    existingProgress.endDate = endDate;

    await fs.writeFile(progressPath, JSON.stringify(existingProgress, null, 2));
  }
}

export default TwitterPipeline;
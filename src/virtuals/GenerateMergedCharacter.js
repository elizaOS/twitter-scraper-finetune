import fs from 'fs/promises';
import path from 'path';
import Logger from '../twitter/Logger.js';

async function main() {
  try {
    const [mergedUsername, date] = process.argv.slice(2);
    if (!mergedUsername || !date) {
      console.error('Usage: npm run generate-merged -- <merged_username> <date>');
      process.exit(1);
    }

    console.log(`Generating merged Virtuals character card for ${mergedUsername} on ${date}`);

    const baseDir = path.join(process.cwd(), 'pipeline', mergedUsername, date);
    const tweetsPath = path.join(baseDir, 'raw', 'tweets.json');
    const mergeStatsPath = path.join(baseDir, 'raw', 'merge_stats.json');
    const virtualsFile = path.join(baseDir, 'character', 'virtuals_character.json');

    try {
      const tweets = JSON.parse(await fs.readFile(tweetsPath, 'utf-8'));
      const mergeStats = JSON.parse(await fs.readFile(mergeStatsPath, 'utf-8'));
      
      console.log(`Found ${tweets.length} tweets from merged accounts: ${mergeStats.sourceAccounts.join(', ')}`);

      // Create Virtuals.io format character card
      const virtualsData = {
        version: "1.0",
        name: mergedUsername,
        description: `Merged character combining perspectives from ${mergeStats.sourceAccounts.join(', ')}`,
        traits: {
          personality: extractPersonalityTraits(tweets),
          interests: extractInterests(tweets),
          communication_style: analyzeCommStyle(tweets)
        },
        metadata: {
          source: "twitter_merged",
          date_created: new Date().toISOString(),
          date_range: {
            start: date,
            end: date
          },
          tweet_count: tweets.length,
          source_accounts: mergeStats.sourceAccounts
        },
        knowledge_base: {
          topics: extractTopics(tweets),
          expertise_areas: analyzeExpertise(tweets)
        }
      };

      // Save Virtuals character card
      await fs.mkdir(path.dirname(virtualsFile), { recursive: true });
      await fs.writeFile(virtualsFile, JSON.stringify(virtualsData, null, 2));

      Logger.success(`✨ Generated Virtuals character card for merged accounts as @${mergedUsername}`);
      Logger.info(`📁 Saved to: ${virtualsFile}`);

    } catch (error) {
      throw new Error(`Failed to process merged character data: ${error.message}`);
    }

  } catch (error) {
    Logger.error(`Failed to generate merged character card: ${error.message}`);
    process.exit(1);
  }
}

// Helper functions for analyzing tweets
function extractPersonalityTraits(tweets) {
  // Basic trait extraction logic
  const traits = new Set();
  tweets.forEach(tweet => {
    const text = tweet.text.toLowerCase();
    if (text.includes('build') || text.includes('create')) traits.add('builder');
    if (text.includes('learn') || text.includes('study')) traits.add('curious');
    // Add more trait detection
  });
  return Array.from(traits);
}

function extractInterests(tweets) {
  // Extract interests from hashtags and frequent topics
  const interests = new Set();
  tweets.forEach(tweet => {
    tweet.hashtags?.forEach(tag => interests.add(tag.toLowerCase()));
  });
  return Array.from(interests);
}

function analyzeCommStyle(tweets) {
  // Analyze communication style
  return {
    tone: analyzeTone(tweets),
    format: "concise", // Default for now
    engagement_level: "high"
  };
}

function analyzeTone(tweets) {
  // Basic tone analysis
  const tones = [];
  const avgLength = tweets.reduce((sum, t) => sum + t.text.length, 0) / tweets.length;
  if (avgLength < 100) tones.push("concise");
  if (avgLength > 200) tones.push("detailed");
  return tones;
}

function extractTopics(tweets) {
  // Extract main topics from tweets
  const topics = new Map();
  tweets.forEach(tweet => {
    const words = tweet.text.toLowerCase().split(/\W+/);
    words.forEach(word => {
      if (word.length > 4) {
        topics.set(word, (topics.get(word) || 0) + 1);
      }
    });
  });
  
  return Array.from(topics)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 10)
    .map(([topic]) => topic);
}

function analyzeExpertise(tweets) {
  // Determine areas of expertise based on engagement
  const expertise = new Map();
  tweets.forEach(tweet => {
    const engagement = tweet.likes + tweet.retweetCount;
    const topics = tweet.text.toLowerCase().split(/\W+/).filter(w => w.length > 4);
    topics.forEach(topic => {
      expertise.set(topic, (expertise.get(topic) || 0) + engagement);
    });
  });
  
  return Array.from(expertise)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 5)
    .map(([topic]) => ({
      area: topic,
      confidence: "high"
    }));
}

main(); 
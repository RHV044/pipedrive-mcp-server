import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as pipedrive from "pipedrive/v1";
import * as dotenv from 'dotenv';

// Type for error handling
interface ErrorWithMessage {
  message: string;
}

function isErrorWithMessage(error: unknown): error is ErrorWithMessage {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as Record<string, unknown>).message === 'string'
  );
}

function getErrorMessage(error: unknown): string {
  if (isErrorWithMessage(error)) {
    return error.message;
  }
  return String(error);
}

// Load environment variables
dotenv.config();

// Check for required environment variables
if (!process.env.PIPEDRIVE_API_TOKEN) {
  console.error("ERROR: PIPEDRIVE_API_TOKEN environment variable is required");
  process.exit(1);
}

// Initialize Pipedrive API configuration with API token
const configuration = new pipedrive.Configuration({
  apiKey: process.env.PIPEDRIVE_API_TOKEN
});

// Initialize Pipedrive API clients
const dealsApi = new pipedrive.DealsApi(configuration);
const personsApi = new pipedrive.PersonsApi(configuration);
const organizationsApi = new pipedrive.OrganizationsApi(configuration);
const pipelinesApi = new pipedrive.PipelinesApi(configuration);
const itemSearchApi = new pipedrive.ItemSearchApi(configuration);
const leadsApi = new pipedrive.LeadsApi(configuration);

// Create MCP server
const server = new McpServer({
  name: "pipedrive-mcp-server",
  version: "1.0.0",
  capabilities: {
    resources: {},
    tools: {},
    prompts: {}
  }
});

// === TOOLS ===

// Get all deals with pagination
server.tool(
  "get-deals",
  "Get all deals from Pipedrive including custom fields",
  {
    status: z.enum(['open', 'won', 'lost', 'deleted', 'all_not_deleted']).optional().describe("Filter by deal status (default: all_not_deleted)"),
    count_only: z.boolean().optional().describe("Return only the count of deals")
  },
  async ({ status, count_only }) => {
    try {
      const allDeals: any[] = [];
      let start = 0;
      const limit = 500; // Maximum allowed by Pipedrive API
      let hasMore = true;
      let pageCount = 0;

      console.log(`\n========== STARTING GET-DEALS ==========`);
      console.log(`Status filter: ${status || 'all_not_deleted'}`);
      console.log(`Count only: ${count_only || false}`);
      console.log(`Limit per page: ${limit}`);

      while (hasMore) {
        pageCount++;
        console.log(`\n--- Page ${pageCount} ---`);
        console.log(`Requesting deals from start=${start}, limit=${limit}`);
        
        const response = await (dealsApi as any).getDeals({
          start,
          limit,
          status: status || 'all_not_deleted'
        });
        
        // Log the raw API response structure
        console.log(`API Response received:`);
        console.log(`- success: ${response.success}`);
        console.log(`- data type: ${Array.isArray(response.data) ? 'array' : typeof response.data}`);
        console.log(`- data length: ${response.data?.length || 0}`);
        
        if (response.additional_data) {
          console.log(`- additional_data.pagination:`, JSON.stringify(response.additional_data.pagination, null, 2));
        } else {
          console.log(`- additional_data: NOT PRESENT`);
        }
        
        if (response.data && Array.isArray(response.data)) {
          const pageDeals = response.data.length;
          if (!count_only) {
            allDeals.push(...response.data);
          }
          console.log(`✓ Added ${pageDeals} deals to collection. Total so far: ${count_only ? start + pageDeals : allDeals.length}`);
        } else {
          console.log(`✗ No data array in response`);
        }
        
        // Check if there are more pages
        const additionalData = (response as any).additional_data;
        hasMore = additionalData?.pagination?.more_items_in_collection || false;
        
        console.log(`Has more pages: ${hasMore}`);
        
        if (hasMore) {
          start += limit;
          console.log(`Moving to next page, new start: ${start}`);
        }
        
        // Safety break to prevent infinite loops
        if (start >= 10000) {
          console.warn(`⚠️  Reached safety limit of 10000 deals at start=${start}`);
          break;
        }
      }

      const totalCount = count_only ? start : allDeals.length;
      console.log(`\n========== FINISHED GET-DEALS ==========`);
      console.log(`Total pages fetched: ${pageCount}`);
      console.log(`Total deals collected: ${totalCount}`);
      console.log(`==========================================\n`);

      if (count_only) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              total_count: totalCount,
              status_filter: status || 'all_not_deleted',
              message: `Found ${totalCount} deals`
            }, null, 2)
          }]
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            total_count: allDeals.length,
            status_filter: status || 'all_not_deleted',
            deals: allDeals
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error("❌ ERROR in get-deals:", error);
      console.error("Error details:", JSON.stringify(error, null, 2));
      return {
        content: [{
          type: "text",
          text: `Error fetching deals: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get deal by ID
server.tool(
  "get-deal",
  "Get a specific deal by ID including custom fields",
  {
    dealId: z.number().describe("Pipedrive deal ID")
  },
  async ({ dealId }) => {
    try {
      const response = await (dealsApi as any).getDeal({ id: dealId });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error fetching deal ${dealId}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error fetching deal ${dealId}: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get deal history/changelog
server.tool(
  "get-deal-history",
  "Get the complete change history and timeline of a specific deal including all updates, stage changes, notes, activities, and who made each change",
  {
    dealId: z.number().describe("Pipedrive deal ID"),
    limit: z.number().optional().describe("Number of history items to return (default 100)")
  },
  async ({ dealId, limit }) => {
    try {
      console.log(`\n========== FETCHING DEAL ${dealId} HISTORY ==========`);
      
      // Use getDealChangelog method from the SDK
      const response = await (dealsApi as any).getDealChangelog({ 
        id: dealId, 
        cursor: undefined, 
        limit: limit || 100 
      });
      
      console.log(`Deal ${dealId} history retrieved:`);
      console.log(`- Items found: ${response.data?.length || 0}`);
      
      if (response.additional_data?.next_cursor) {
        console.log(`- Has more items: ${response.additional_data.next_cursor}`);
      }
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            deal_id: dealId,
            history_count: response.data?.length || 0,
            next_cursor: response.additional_data?.next_cursor || null,
            history: response.data || []
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error fetching deal ${dealId} history:`, error);
      return {
        content: [{
          type: "text",
          text: `Error fetching deal ${dealId} history: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Search deals
server.tool(
  "search-deals",
  "Search deals by term",
  {
    term: z.string().describe("Search term for deals")
  },
  async ({ term }) => {
    try {
      const response = await dealsApi.searchDeals({ term });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error searching deals with term "${term}":`, error);
      return {
        content: [{
          type: "text",
          text: `Error searching deals: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get all persons with pagination
server.tool(
  "get-persons",
  "Get all persons from Pipedrive including custom fields",
  {},
  async () => {
    try {
      const allPersons: any[] = [];
      let start = 0;
      const limit = 500; // Maximum allowed by Pipedrive API
      let hasMore = true;
      let pageCount = 0;

      console.log(`\n========== STARTING GET-PERSONS ==========`);
      console.log(`Limit per page: ${limit}`);

      while (hasMore) {
        pageCount++;
        console.log(`\n--- Page ${pageCount} ---`);
        console.log(`Requesting persons from start=${start}, limit=${limit}`);
        
        const response = await (personsApi as any).getPersons({
          start,
          limit
        });
        
        console.log(`API Response received:`);
        console.log(`- success: ${response.success}`);
        console.log(`- data length: ${response.data?.length || 0}`);
        
        if (response.additional_data?.pagination) {
          console.log(`- pagination:`, JSON.stringify(response.additional_data.pagination, null, 2));
        }
        
        if (response.data && Array.isArray(response.data)) {
          allPersons.push(...response.data);
          console.log(`✓ Added ${response.data.length} persons. Total: ${allPersons.length}`);
        }
        
        // Check if there are more pages
        const additionalData = (response as any).additional_data;
        hasMore = additionalData?.pagination?.more_items_in_collection || false;
        
        console.log(`Has more pages: ${hasMore}`);
        
        if (hasMore) {
          start += limit;
        }
        
        // Safety break to prevent infinite loops
        if (start >= 10000) {
          console.warn(`⚠️  Reached safety limit of 10000 persons`);
          break;
        }
      }

      console.log(`\n========== FINISHED GET-PERSONS ==========`);
      console.log(`Total pages: ${pageCount}, Total persons: ${allPersons.length}`);
      console.log(`==========================================\n`);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            total_count: allPersons.length,
            persons: allPersons
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error("❌ ERROR in get-persons:", error);
      return {
        content: [{
          type: "text",
          text: `Error fetching persons: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get person by ID
server.tool(
  "get-person",
  "Get a specific person by ID including custom fields",
  {
    personId: z.number().describe("Pipedrive person ID")
  },
  async ({ personId }) => {
    try {
      const response = await personsApi.getPerson({ id: personId });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error fetching person ${personId}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error fetching person ${personId}: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Search persons
server.tool(
  "search-persons",
  "Search persons by term",
  {
    term: z.string().describe("Search term for persons")
  },
  async ({ term }) => {
    try {
      const response = await personsApi.searchPersons({ term });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error searching persons with term "${term}":`, error);
      return {
        content: [{
          type: "text",
          text: `Error searching persons: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get all organizations with pagination
server.tool(
  "get-organizations",
  "Get all organizations from Pipedrive including custom fields",
  {},
  async () => {
    try {
      const allOrganizations: any[] = [];
      let start = 0;
      const limit = 500; // Maximum allowed by Pipedrive API
      let hasMore = true;
      let pageCount = 0;

      console.log(`\n========== STARTING GET-ORGANIZATIONS ==========`);
      console.log(`Limit per page: ${limit}`);

      while (hasMore) {
        pageCount++;
        console.log(`\n--- Page ${pageCount} ---`);
        console.log(`Requesting organizations from start=${start}, limit=${limit}`);
        
        const response = await (organizationsApi as any).getOrganizations({
          start,
          limit
        });
        
        console.log(`API Response received:`);
        console.log(`- success: ${response.success}`);
        console.log(`- data length: ${response.data?.length || 0}`);
        
        if (response.additional_data?.pagination) {
          console.log(`- pagination:`, JSON.stringify(response.additional_data.pagination, null, 2));
        }
        
        if (response.data && Array.isArray(response.data)) {
          allOrganizations.push(...response.data);
          console.log(`✓ Added ${response.data.length} organizations. Total: ${allOrganizations.length}`);
        }
        
        // Check if there are more pages
        const additionalData = (response as any).additional_data;
        hasMore = additionalData?.pagination?.more_items_in_collection || false;
        
        console.log(`Has more pages: ${hasMore}`);
        
        if (hasMore) {
          start += limit;
        }
        
        // Safety break to prevent infinite loops
        if (start >= 10000) {
          console.warn(`⚠️  Reached safety limit of 10000 organizations`);
          break;
        }
      }

      console.log(`\n========== FINISHED GET-ORGANIZATIONS ==========`);
      console.log(`Total pages: ${pageCount}, Total organizations: ${allOrganizations.length}`);
      console.log(`================================================\n`);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            total_count: allOrganizations.length,
            organizations: allOrganizations
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error("❌ ERROR in get-organizations:", error);
      return {
        content: [{
          type: "text",
          text: `Error fetching organizations: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get organization by ID
server.tool(
  "get-organization",
  "Get a specific organization by ID including custom fields",
  {
    organizationId: z.number().describe("Pipedrive organization ID")
  },
  async ({ organizationId }) => {
    try {
      const response = await organizationsApi.getOrganization({ id: organizationId });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error fetching organization ${organizationId}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error fetching organization ${organizationId}: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Search organizations
server.tool(
  "search-organizations",
  "Search organizations by term",
  {
    term: z.string().describe("Search term for organizations")
  },
  async ({ term }) => {
    try {
      const response = await organizationsApi.searchOrganization({ term });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error searching organizations with term "${term}":`, error);
      return {
        content: [{
          type: "text",
          text: `Error searching organizations: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get all pipelines
server.tool(
  "get-pipelines",
  "Get all pipelines from Pipedrive",
  {},
  async () => {
    try {
      const response = await pipelinesApi.getPipelines();
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error("Error fetching pipelines:", error);
      return {
        content: [{
          type: "text",
          text: `Error fetching pipelines: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get pipeline by ID
server.tool(
  "get-pipeline",
  "Get a specific pipeline by ID",
  {
    pipelineId: z.number().describe("Pipedrive pipeline ID")
  },
  async ({ pipelineId }) => {
    try {
      const response = await pipelinesApi.getPipeline({ id: pipelineId });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error fetching pipeline ${pipelineId}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error fetching pipeline ${pipelineId}: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get all stages
server.tool(
  "get-stages",
  "Get all stages from Pipedrive",
  {},
  async () => {
    try {
      // Since the stages are related to pipelines, we'll get all pipelines first
      const pipelinesResponse = await pipelinesApi.getPipelines();
      const pipelines = pipelinesResponse.data || [];
      
      // For each pipeline, fetch its stages
      const allStages = [];
      for (const pipeline of pipelines) {
        try {
          // This is using the API to get stages by pipeline ID
          const stagesResponse = await fetch(`https://api.pipedrive.com/api/v2/stages?pipeline_id=${pipeline.id}&api_token=${process.env.PIPEDRIVE_API_TOKEN}`);
          const stagesData = await stagesResponse.json();
          
          if (stagesData.success && stagesData.data) {
            const pipelineStages = stagesData.data.map((stage: any) => ({
              ...stage,
              pipeline_name: pipeline.name
            }));
            allStages.push(...pipelineStages);
          }
        } catch (e) {
          console.error(`Error fetching stages for pipeline ${pipeline.id}:`, e);
        }
      }
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(allStages, null, 2)
        }]
      };
    } catch (error) {
      console.error("Error fetching stages:", error);
      return {
        content: [{
          type: "text",
          text: `Error fetching stages: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Search leads
server.tool(
  "search-leads",
  "Search leads by term",
  {
    term: z.string().describe("Search term for leads")
  },
  async ({ term }) => {
    try {
      const response = await leadsApi.searchLeads({ term });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error searching leads with term "${term}":`, error);
      return {
        content: [{
          type: "text",
          text: `Error searching leads: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Generic search across item types
server.tool(
  "search-all",
  "Search across all item types (deals, persons, organizations, etc.)",
  {
    term: z.string().describe("Search term"),
    itemTypes: z.string().optional().describe("Comma-separated list of item types to search (deal,person,organization,product,file,activity,lead)")
  },
  async ({ term, itemTypes }) => {
    try {
      const response = await itemSearchApi.searchItem({ 
        term,
        item_types: itemTypes as any
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error performing search with term "${term}":`, error);
      return {
        content: [{
          type: "text",
          text: `Error performing search: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// === PROMPTS ===

// Prompt for getting all deals
server.prompt(
  "list-all-deals",
  "List all deals in Pipedrive",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Please list all deals in my Pipedrive account, showing their title, value, status, and stage."
      }
    }]
  })
);

// Prompt for getting all persons
server.prompt(
  "list-all-persons",
  "List all persons in Pipedrive",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Please list all persons in my Pipedrive account, showing their name, email, phone, and organization."
      }
    }]
  })
);

// Prompt for getting all pipelines
server.prompt(
  "list-all-pipelines",
  "List all pipelines in Pipedrive",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Please list all pipelines in my Pipedrive account, showing their name and stages."
      }
    }]
  })
);

// Prompt for analyzing deals
server.prompt(
  "analyze-deals",
  "Analyze deals by stage",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Please analyze the deals in my Pipedrive account, grouping them by stage and providing total value for each stage."
      }
    }]
  })
);

// Prompt for analyzing contacts
server.prompt(
  "analyze-contacts",
  "Analyze contacts by organization",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Please analyze the persons in my Pipedrive account, grouping them by organization and providing a count for each organization."
      }
    }]
  })
);

// Prompt for analyzing leads
server.prompt(
  "analyze-leads",
  "Analyze leads by status",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Please search for all leads in my Pipedrive account and group them by status."
      }
    }]
  })
);

// Prompt for pipeline comparison
server.prompt(
  "compare-pipelines",
  "Compare different pipelines and their stages",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Please list all pipelines in my Pipedrive account and compare them by showing the stages in each pipeline."
      }
    }]
  })
);

// Prompt for finding high-value deals
server.prompt(
  "find-high-value-deals",
  "Find high-value deals",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Please identify the highest value deals in my Pipedrive account and provide information about which stage they're in and which person or organization they're associated with."
      }
    }]
  })
);

// Start the server with stdio transport
const transport = new StdioServerTransport();
server.connect(transport).catch(err => {
  console.error("Failed to start MCP server:", err);
  process.exit(1);
});

console.error("Pipedrive MCP Server started");

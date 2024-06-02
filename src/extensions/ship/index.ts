import { emitter } from "../../lib/emitter.js";
import { app } from "../../lib/bolt.js";
import { prisma, uid } from "../../lib/prisma.js";

import { Environment } from "../../lib/constants.js";
import { Actions, Ship } from "./view.js";
import { updateController, updateTopLevel } from "../slack/lib/lib.js";

import { AirtableAPI } from "./airtable.js";
import { Prisma, Session } from "@prisma/client";

import { Constants } from "./constants.js";

let enabled = true;

function extractFromPermalink(permalink: string) {
    // Slack permalink 
    // <https://hackclub.slack.com/archives/C074J205DD0/p1716621537596569>

    // Extract channel and ts
    const channel = permalink.match(/archives\/(C\w+)\//)?.[1];
    let ts = permalink.match(/p(\d+)/)?.[1];

    if (!channel || !ts) {
        throw new Error("Channel or ts is null");
    }

    ts = ts.slice(0, -6) + "." + ts.slice(-6);

    return { channel, ts };
}

app.message(async ({ message }) => {
    if (!enabled) { return; }
    if (
        !(message.channel === Environment.SHIP_CHANNEL || message.channel === Environment.SCRAPBOOK_CHANNEL)
    ) { return };
    if (!message.subtype || message.subtype !== 'file_share') { return }; // Needs to be a file share event
    
    // Make sure the user is in the database
    const user = await prisma.user.findFirst({
        where: {
            slackUser: {
                slackId: message.user
            }
        },
    });

    if (!user) { return; } //TODO: Advertise the user to sign up

    let metadata: any | null = user.metadata;

    if (!metadata) { 
        metadata = {
            ships: []
        }
    } else if (!metadata.ships) {
        metadata.ships = [];
    }

    const shipTs = message.ts;

    // DM the user to let them know that their ship has been received
    const result = await app.client.chat.postMessage({
        channel: message.user,
        blocks: await Ship.init(shipTs)
    });

    metadata.ships.push({
        shipTs,
        message: result.ts
    });

    await prisma.user.update({
        where: {
            id: user.id
        },
        data: {
            metadata
        }
    });
});

// Test ship flow
app.command(Environment.PROD ? "/admin" : "/testadmin", async ({ command, ack }) => {
    if (!Constants.VERIFIERS.includes(command.user_id)) { 
        ack({
            response_type: "ephemeral",
            text: "O.o"
        });

        return;
    }

    const args = command.text.split(" ");
    const subCommand = args[0];
    const subArgs = args.slice(1);

    if (subCommand === "delete") {
        // Delete message from link
        await app.client.chat.delete({
            channel: subArgs[0],
            ts: subArgs[1]
        });

        return;
    }

    await ack();

    enabled = !enabled;

    await app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: `Arcade is now ${enabled ? "enabled" : "disabled"}`
    });

});

app.action(Actions.OPEN_SESSION_REVIEW, async ({ ack, body }) => {
    const { id } = body.channel as any;
    const { user } = body;
    const { ts } = (body as any).message;

    const dbUser = await prisma.user.findFirstOrThrow({
        where: {
            slackUser: {
                slackId: user.id
            }
        }
    });

    const shipTs = (dbUser.metadata as any).ships.find((ship: any) => ship.message === ts)?.shipTs;

    await ack();

    await app.client.chat.update({
        channel: id,
        ts,
        blocks: await Ship.openSessionReview(user.id, shipTs),
        metadata: {
            event_type: "shipTs",
            event_payload: {
                ts: shipTs
            }
        }
    });
});

app.action(Actions.UPDATE_SESSION_GOAL, async ({ ack, body }) => {
    const { goalId, sessionTs } = JSON.parse((body as any).actions[0].selected_option.value);
    const { id } = body.channel as any;
    const { user } = body;
    const { ts } = (body as any).message;

    const dbUser = await prisma.user.findFirstOrThrow({
        where: {
            slackUser: {
                slackId: user.id
            }
        }
    });

    const shipTs = (dbUser.metadata as any).ships.find((ship: any) => ship.message === ts)?.shipTs;

    let session = await prisma.session.findUniqueOrThrow({
        where: {
            messageTs: sessionTs,
            OR: [
                {
                    completed: true
                },
                {
                    cancelled: true
                }
            ]            
        },
        include: {
            goal: true
        }
    });

    if (!session.goal) { throw new Error(`No goal found for session ${sessionTs}`); }

    if (session.goal.completed) {
        // Something happened to the goal, so we need to refresh the view
        ack();
        await app.client.chat.update({
            channel: id,
            ts,
            blocks: await Ship.openSessionReview(user.id, shipTs),
            metadata: {
                event_type: "shipTs",
                event_payload: {
                    ts: shipTs
                }
            }
        });
        return;
    }
    
    await prisma.goal.update({
        where: {
            id: session.goal.id
        },
        data: {
            totalMinutes: {
                decrement: session.elapsed
            }
        }
    });

    // Update the session with the goal id
    session = await prisma.session.update({
        where: {
            messageTs: sessionTs,
            goal: {
                completed: false
            }
        },
        data: {
            goal: {
                connect: {
                    id: goalId
                }
            }
        },
        include: {
            goal: true
        }
    });   

    await prisma.goal.update({
        where: {
            id: goalId
        },
        data: {
            totalMinutes: {
                increment: session.elapsed
            }
        }
    });

    await app.client.chat.update({
        channel: id,
        ts,
        blocks: await Ship.openSessionReview(user.id, shipTs),
        metadata: {
            event_type: "shipTs",
            event_payload: {
                ts: shipTs
            }
        }
    });

    await updateController(session);
    await updateTopLevel(session);

    await ack();
});

app.action(Actions.OPEN_GOAL_SELECT, async ({ ack, body  }) => {
    const { id } = body.channel as any;
    const { user } = body;
    const { ts } = (body as any).message;

    const dbUser = await prisma.user.findFirstOrThrow({
        where: {
            slackUser: {
                slackId: user.id
            }
        }
    });

    const shipTs = (dbUser.metadata as any).ships.find((ship: any) => ship.message === ts)?.shipTs;

    await ack();

    await app.client.chat.update({
        channel: id,
        ts,
        blocks: await Ship.openGoalSelect(user.id),
        metadata: {
            event_type: "shipTs",
            event_payload: {
                ts: shipTs
            }
        }
    });
});

const fetchOrCreateUser = async (user: Prisma.UserGetPayload<{include: { slackUser: true }}>) => {
    let airtableUser = await AirtableAPI.User.fetch(user.id);

    if (!user.slackUser) { throw new Error(`No slack user found for ${user.id}`); }
    
    if (!airtableUser) { 
        const slackInfo = await app.client.users.info({
            user: user.slackUser.slackId
        });
        if (!slackInfo.user?.real_name) { throw new Error(`No user found for ${user.slackUser.slackId}`); }

        airtableUser = await AirtableAPI.User.create({
            "Name": slackInfo.user.real_name,
            "Internal ID": user.id,
            "Slack ID": user.slackUser.slackId,
            "Banked Minutes": 0,
            "Ships": [],
            "Sessions": []
        });
    }
    
    return airtableUser;
}

app.action(Actions.CONFIRM_GOAL_SELECT, async ({ ack, body }) => {
    const { id } = body.channel as any;
    const { user } = body;
    const { ts } = (body as any).message;

    const dbUser = await prisma.user.findFirstOrThrow({
        where: {
            slackUser: {
                slackId: user.id
            }
        }
    });

    const shipTs = (dbUser.metadata as any).ships.find((ship: any) => ship.message === ts)?.shipTs;

    const values = (body as any).state.values;

    if (!values || Object.keys(values).length === 0) {
        await ack();

        await app.client.chat.postEphemeral({
            user: body.user.id,
            channel: body.user.id,
            text: "You need to select a goal to submit"
        });

        return;
    }

    await ack();

    await app.client.chat.update({
        channel: id,
        ts,
        blocks: await Ship.confirm(user.id),
        metadata: {
            event_type: "shipTs",
            event_payload: {
                ts: shipTs,
                goal: values.goals.select.selected_option.value
            }
        }
    });
});

app.action(Actions.SUBMIT, async ({ ack, body }) => {
    const { user: slack } = body;
    const { ts } = (body as any).message;

    const dbUser = await prisma.user.findFirstOrThrow({
        where: {
            slackUser: {
                slackId: slack.id
            }
        }
    });

    const shipTs = (dbUser.metadata as any).ships.find((ship: any) => ship.message === ts)?.shipTs;

    const goalId = (body as any).message.metadata.event_payload.goal;

    let shipUrl: string | undefined;
    try {
        shipUrl = (await app.client.chat.getPermalink({
            channel: Environment.SHIP_CHANNEL,
            message_ts: shipTs
        })).permalink;
    } catch (e) {
        shipUrl = (await app.client.chat.getPermalink({
            channel: Environment.SCRAPBOOK_CHANNEL,
            message_ts: shipTs
        })).permalink;
    }
 
    if (!shipUrl) { throw new Error(`No permalink found for ${shipTs}` ); }

    await ack();

    const user = await prisma.user.findFirstOrThrow({
        where: {
            slackUser: {
                slackId: body.user.id
            }
        },
        include: {
            slackUser: true
        }
    });

    const sessions = await prisma.session.findMany({
        where: {
            goalId            
        }
    });

    await prisma.bank.create({
        data: {
            id: uid(),
            user: {
                connect: {
                    id: user.id
                }
            },
            minutes: 0,
            type: "ship",
            sessions: {
                connect: sessions.map(session => {
                    return {
                        messageTs: session.messageTs
                    }
                })
            },
            data: {
                shipTs,
                shipUrl: shipUrl
            }
        }
    });

    const oldGoal = await prisma.goal.update({
        where: {
            id: goalId
        },
        data: {
            completed: true
        },
        include: {
            sessions: true
        }
    });

    // Update the user's sessions
    oldGoal.sessions.forEach(async session => {
        updateController(session);
        updateTopLevel(session);
    });

    // Create a new identical goal to replace the old one
    await prisma.goal.create({
        data: {
            id: uid(),
            name: oldGoal.name,
            description: oldGoal.description,
            completed: false,
            user: {
                connect: {
                    id: user.id
                }
            },
            totalMinutes: oldGoal.totalMinutes,
            selected: oldGoal.selected,
            createdAt: oldGoal.createdAt,
        }
    });

    await prisma.goal.update({
        where: {
            id: oldGoal.id
        },
        data: {
            selected: false
        }
    });

    // Update on Airtable
    const { id } = await fetchOrCreateUser(user);

    await AirtableAPI.Ship.create({
        "Ship URL": shipUrl, 
        "User": [id],
        "Minutes": 0,
        "Goal Name": oldGoal.name,
        "Created At": new Date().toISOString(),
        "Status": "Unreviewed",
        "Sessions": sessions.map(session => {
            return (session.metadata as any).airtable.id;
        })
    });

    if (!body.channel?.id) {
        emitter.emit('error', new Error(`No channel found for ${body.user.id}`));
        return;
    }

    await app.client.chat.update({
        channel: body.channel.id,
        ts: (body as any).message.ts,
        blocks: await Ship.complete(),
    });
});

const registerSession = async (session: Session) => {
    if (!enabled) { return; }

    const user = await prisma.user.findFirstOrThrow({
        where: {
            id: session.userId
        },
        include: {
            slackUser: true
        }
    });

    const { id, fields } = await fetchOrCreateUser(user);

    const permalink = await app.client.chat.getPermalink({
        channel: Environment.MAIN_CHANNEL,
        message_ts: session.messageTs
    });

    if (!permalink.permalink) { throw new Error(`No permalink found for ${session.messageTs}` ); }

    // Create a new session
    const { id: sid, fields: sfields } = await AirtableAPI.Session.create({
        "Code URL": permalink.permalink,
        "User": [id],
        "Work": (session.metadata as any).work,
        "Minutes": session.elapsed,
        "Status": "Unreviewed",
        "Created At": session.createdAt.toISOString(),
    });

    console.log(`Registered session ${session.messageTs} for ${id} in the Airtable`);

    await prisma.session.update({
        where: {
            messageTs: session.messageTs
        },
        data: {
            metadata: {
                ...(session.metadata as any),
                airtable: {
                    id: sid
                }
            }
        }
    });
};

emitter.on('complete', async (session: Session) => {
    await registerSession(session);
});

emitter.on('cancel', async (session: Session) => {
    await registerSession(session);
});
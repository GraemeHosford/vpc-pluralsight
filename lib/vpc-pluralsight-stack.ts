import {RemovalPolicy, Stack, StackProps} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as ec2 from "aws-cdk-lib/aws-ec2";
import {CfnVPCPeeringConnection, FlowLogDestination, FlowLogTrafficType} from "aws-cdk-lib/aws-ec2";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import {RetentionDays} from "aws-cdk-lib/aws-logs";
import {PolicyStatement, ServicePrincipal} from "aws-cdk-lib/aws-iam";

/**
 * Stack contains resources related to Pluralsight VPC deep dive course.
 *
 * Some resources which look at setting up a transit VPC and CloudHub are
 * contained with the TransitVpcConstruct class. These resources rely on on-prem services
 * which don't actually exist and also include some manual steps which cannot be done through code.
 * The infra setup for these resources is contained in this class for sake of example but
 * the construct itself is not being used as deploying it would cause errors and the whole setup would
 * not work as expected.
 *
 * The Pluralsight course also has a module on setting up ipv6 connectivity in VPCs but this is not
 * supported in CDK so not included here.
 * See open Github issue: https://github.com/aws/aws-cdk/issues/894
 */
export class VpcPluralsightStack extends Stack {
    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);

        /* Create a VPC to act as public facing part of infra */
        const publicVpc = new ec2.Vpc(this, "PublicVpc", {
            vpcName: "web-vpc",
            cidr: "10.1.0.0/16",
            // If left undefined CDK tries to create default subnets which causes conflict and errors
            // Empty array prevents this
            subnetConfiguration: []
        });
        publicVpc.applyRemovalPolicy(RemovalPolicy.DESTROY);

        /* Create a public subnet which holds the public facing parts of a web app */
        const publicSubnet = new ec2.Subnet(this, "PublicSubnet", {
            vpcId: publicVpc.vpcId,
            availabilityZone: "eu-west-1a",
            cidrBlock: "10.1.254.0/24"
        });
        publicSubnet.applyRemovalPolicy(RemovalPolicy.DESTROY);

        /* Create a route table tied to the public VPC */
        const publicRouteTable = new ec2.CfnRouteTable(this, "PublicRouteTable", {
            vpcId: publicVpc.vpcId
        });
        publicRouteTable.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const publicSubnetRouteTableAssociation =
            new ec2.CfnSubnetRouteTableAssociation(this, "PublicRouteTableSubnetAssociation1", {
                subnetId: publicSubnet.subnetId,
                routeTableId: publicRouteTable.attrRouteTableId
            });
        publicSubnetRouteTableAssociation.applyRemovalPolicy(RemovalPolicy.DESTROY);

        /* Create an internet gateway which allow public VPC to access the outside world and vice versa */
        const publicInternetGateway = new ec2.CfnInternetGateway(this, "PublicInternetGateway");
        publicInternetGateway.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const publicVpcIgwAttachment = new ec2.CfnVPCGatewayAttachment(this, "PublicVpcIgwAttachment", {
            vpcId: publicVpc.vpcId,
            internetGatewayId: publicInternetGateway.attrInternetGatewayId
        });
        publicVpcIgwAttachment.applyRemovalPolicy(RemovalPolicy.DESTROY);

        /* cidr block 0.0.0.0/0 means all IPV4 traffic should get access to internet ingress and egress */
        const route = new ec2.CfnRoute(this, "PublicInternetAccessRoute", {
            routeTableId: publicRouteTable.attrRouteTableId,
            destinationCidrBlock: "0.0.0.0/0",
            gatewayId: publicInternetGateway.attrInternetGatewayId
        });
        route.applyRemovalPolicy(RemovalPolicy.DESTROY);

        /* Create a new security group attached to the public facing VPC.
        * Allow SSH access into this VPC using a specific IP range 24.96.0.0/16
        * Allow any ipv4 or ipv6 address to connect to this VPC */
        const publicSecurityGroup = new ec2.SecurityGroup(this, "PublicSecurityGroup", {
            vpc: publicVpc,
            securityGroupName: "web-pub-sg",
            description: "Public VPC security group",
            // Allow the VPC to make connections to the outside world.
            // True by default but making explicit here
            allowAllOutbound: true
        });
        publicSecurityGroup.applyRemovalPolicy(RemovalPolicy.DESTROY);
        publicSecurityGroup.addIngressRule(
            ec2.Peer.ipv4("24.96.0.0/16"),
            ec2.Port.tcp(22),
            "SSH access from IP range 24.96.0.0/16"
        );
        publicSecurityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(80),
            "Allow access into this public VPC from any ipv4 address"
        );
        publicSecurityGroup.addIngressRule(
            ec2.Peer.anyIpv6(),
            ec2.Port.tcp(80),
            "Allow access into this public VPC from any ipv6 address"
        );

        /* Create a keypair to allow SSH access to a running EC2 instance */
        const sshKeyPair = new ec2.CfnKeyPair(this, "ssh-keypair", {
            keyName: "public-ssh-key-pair"
        });
        sshKeyPair.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const publicEc2Instance = new ec2.Instance(this, "public-ec2-instance", {
            vpc: publicVpc,
            keyName: sshKeyPair.keyName,
            vpcSubnets: {subnets: [publicSubnet]},
            privateIpAddress: "10.1.254.10",
            instanceType: new ec2.InstanceType("t2.micro"),
            machineImage: ec2.MachineImage.latestAmazonLinux(),
            instanceName: "public-ec2-instance",
            securityGroup: publicSecurityGroup
        });
        publicEc2Instance.applyRemovalPolicy(RemovalPolicy.DESTROY);

        /* Creates a new elastic IP and associates it to the EC2 instance tied to the public VPC.
        * This gives the instance a static ipv4 address which can be hit by outside traffic */
        const publicIpv4Address = new ec2.CfnEIP(this, "public-elastic-ip");
        publicIpv4Address.applyRemovalPolicy(RemovalPolicy.DESTROY);
        const publicElasticIpVpcAssociation = new ec2.CfnEIPAssociation(this, "public-elastic-ip-network-interface-assc", {
            instanceId: publicEc2Instance.instanceId,
            allocationId: publicIpv4Address.attrAllocationId
        });
        publicElasticIpVpcAssociation.applyRemovalPolicy(RemovalPolicy.DESTROY);

        /* Create a VPC to act as shared private part of infra */
        const sharedVpc = new ec2.Vpc(this, "SharedVpc", {
            vpcName: "shared-vpc",
            cidr: "10.2.0.0/16",
            // If left undefined CDK tries to create default subnets which causes conflict and errors
            // Empty array prevents this
            subnetConfiguration: []
        });
        sharedVpc.applyRemovalPolicy(RemovalPolicy.DESTROY);

        /* Create a subnet which holds the private database */
        const databaseSubnet = new ec2.Subnet(this, "DatabaseSubnet", {
            vpcId: sharedVpc.vpcId,
            availabilityZone: "eu-west-1a", // Keep zone same as public VPC. Different zones will still work but AWS will charge more
            cidrBlock: "10.2.2.0/24"
        });
        databaseSubnet.applyRemovalPolicy(RemovalPolicy.DESTROY);

        /* Create a route table tied to the shared VPC */
        const sharedVpcRouteTable = new ec2.CfnRouteTable(this, "SharedRouteTable", {
            vpcId: sharedVpc.vpcId
        });
        sharedVpcRouteTable.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const sharedSubnetRouteTableAssociation =
            new ec2.CfnSubnetRouteTableAssociation(this, "SharedRouteTableSubnetAssociation", {
                subnetId: databaseSubnet.subnetId,
                routeTableId: sharedVpcRouteTable.attrRouteTableId
            });
        sharedSubnetRouteTableAssociation.applyRemovalPolicy(RemovalPolicy.DESTROY);

        /* Create a new security group attached to the database instance .
        * Allow SSH access into this VPC using a specific IP ranges 192.168.0.0/16 or 10.2.0.0/16
        * Allow public subnet MySQL access only.
        * Allow any ipv4 to ping instance */
        const databaseSecurityGroup = new ec2.SecurityGroup(this, "DatabaseSecurityGroup", {
            vpc: sharedVpc,
            securityGroupName: "database-sg",
            description: "Database security group",
            // Allow the VPC to make connections to the outside world.
            // True by default but making explicit here
            allowAllOutbound: true
        });
        databaseSecurityGroup.applyRemovalPolicy(RemovalPolicy.DESTROY);
        databaseSecurityGroup.addIngressRule(
            ec2.Peer.ipv4("192.168.0.0/16"),
            ec2.Port.tcp(22),
            "SSH access from IP range 192.168.0.0/16"
        );
        databaseSecurityGroup.addIngressRule(
            ec2.Peer.ipv4("10.2.0.0/16"),
            ec2.Port.tcp(22),
            "SSH access from IP range 10.2.0.0/16"
        );
        databaseSecurityGroup.addIngressRule(
            ec2.Peer.ipv4("10.1.254.0/24"),
            ec2.Port.tcp(3306),
            "MySQL access from public subnet into database instance"
        );
        databaseSecurityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.icmpPing(),
            "Allow ICMP ping from any ipv4"
        );

        /* Instance representing database running in AWS. Using private VPC and database subnet
        * No EiP defined as we don't want to allow public access to this instance */
        const databaseEc2Instance = new ec2.Instance(this, "database-ec2-instance", {
            vpc: sharedVpc,
            keyName: sshKeyPair.keyName,
            vpcSubnets: {subnets: [databaseSubnet]},
            privateIpAddress: "10.2.2.41",
            instanceType: new ec2.InstanceType("t2.micro"),
            machineImage: ec2.MachineImage.latestAmazonLinux(),
            instanceName: "database-ec2-instance",
            securityGroup: databaseSecurityGroup
        });
        databaseEc2Instance.applyRemovalPolicy(RemovalPolicy.DESTROY);

        /*
        * Some limitations of VPC peering:
        * * VPCs can be peered across regions but ipv6 cross-region is not supported
        * * Peered VPCs cannot have overlapping CIDR blocks
        * * An instance in one VPC cannot use the IGW in a peered VPC to reach the internet
        * (less a limitation more an expected security measure,
        * same applies to other resources, MAT gateways, other peering connections, etc)
        *
        * Useful doc on invalid VPC connections
        * https://docs.aws.amazon.com/vpc/latest/peering/invalid-peering-configurations.html
        * */

        // Create peering connection between the two VPCs
        const vpcPeeringConnection = new CfnVPCPeeringConnection(this, "PCX", {
                vpcId: publicVpc.vpcId,
                peerVpcId: sharedVpc.vpcId,
                tags: [{key: "Name", value: "web-shared-pcx"}]
            }
        );
        vpcPeeringConnection.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const publicRouteTablePeeringRoute = new ec2.CfnRoute(this, "public-route-table-peering-route", {
            routeTableId: publicRouteTable.attrRouteTableId,
            destinationCidrBlock: "10.2.2.0/24",
            vpcPeeringConnectionId: vpcPeeringConnection.peerOwnerId
        });
        publicRouteTablePeeringRoute.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const sharedRouteTablePeeringRoute = new ec2.CfnRoute(this, "shared-route-table-peering-route", {
            routeTableId: sharedVpcRouteTable.attrRouteTableId,
            destinationCidrBlock: "10.1.254.0/24",
            vpcPeeringConnectionId: vpcPeeringConnection.peerOwnerId
        });
        sharedRouteTablePeeringRoute.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const sharedInternetGateway = new ec2.CfnInternetGateway(this, "shared-igw", {
            tags: [{ key: "Name", value: "shared-igw" }]
        });
        sharedInternetGateway.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const sharedVpcIgwAttachment = new ec2.CfnVPCGatewayAttachment(this, "SharedVpcIgwAttachment", {
            vpcId: sharedVpc.vpcId,
            internetGatewayId: sharedInternetGateway.attrInternetGatewayId
        });
        sharedVpcIgwAttachment.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const natSubnet = new ec2.Subnet(this, "shared-nat-subnet", {
            vpcId: sharedVpc.vpcId,
            availabilityZone: "eu-west-1a",
            cidrBlock: "10.2.254.0/24"
        });
        natSubnet.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const natRouteTable = new ec2.CfnRouteTable(this, "nat-pub-route-table", {
            vpcId: sharedVpc.vpcId,
            tags: [{ key: "Name", value: "nat-pub" }]
        });
        natRouteTable.applyRemovalPolicy(RemovalPolicy.DESTROY);

        // TODO: Check if even needed after deploying
        // const sharedRouteTableRoute = new ec2.CfnRoute(this, "shared-route-table-route", {
        //     routeTableId: natRouteTable.attrRouteTableId,
        //     destinationCidrBlock: "10.2.0.0/16"
        // });
        // sharedRouteTableRoute.applyRemovalPolicy(RemovalPolicy.DESTROY);
        const defaultNatRoute = new ec2.CfnRoute(this, "default-nat-route", {
            routeTableId: natRouteTable.attrRouteTableId,
            destinationCidrBlock: "0.0.0.0/0",
            gatewayId: sharedInternetGateway.attrInternetGatewayId
        });
        defaultNatRoute.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const natSubnetRouteTableAssociation =
            new ec2.CfnSubnetRouteTableAssociation(this, "NATRouteTableSubnetAssociation", {
                subnetId: natSubnet.subnetId,
                routeTableId: natRouteTable.attrRouteTableId
            });
        natSubnetRouteTableAssociation.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const natSecurityGroup = new ec2.SecurityGroup(this, "nat-security-group", {
            vpc: sharedVpc,
            securityGroupName: "NAT instance",
            description: "Security group for NAT instance"
        });
        natSecurityGroup.applyRemovalPolicy(RemovalPolicy.DESTROY);

        natSecurityGroup.addIngressRule(
            ec2.Peer.ipv4("24.96.0.0/16"),
            ec2.Port.tcp(22),
            "Allow SSH access from ip range 24.96.0.0/16"
        );
        natSecurityGroup.addIngressRule(
            ec2.Peer.ipv4("10.0.0.0/8"),
            ec2.Port.allTraffic(),
            "Allow 10.0.0.0/8 to access all traffic"
        );
        natSecurityGroup.addIngressRule(
            ec2.Peer.ipv4("192.168.0.0/16"),
            ec2.Port.allTraffic(),
            "Allow 192.168.0.0/16 to access all traffic"
        );

        /*
        * In reality this NAT instance would instead be a NAT gateway
        * NAT gateways can handle far more traffic than a NAT instance and are highly available.
        * Neither is true of a NAT instance using size t2.micro
        *
        * Using an instance here to follow along with Pluralsight course
        * */
        // TODO: Check if have to stop source/destination check when deployed
        const natEc2Instance = new ec2.Instance(this, "nat-ec2-instance", {
            vpc: sharedVpc,
            keyName: sshKeyPair.keyName,
            vpcSubnets: {subnets: [natSubnet]},
            privateIpAddress: "10.2.254.254",
            instanceType: new ec2.InstanceType("t2.micro"),
            machineImage: new ec2.NatInstanceImage(),
            instanceName: "nat-ec2-instance",
            securityGroup: natSecurityGroup
        });
        natEc2Instance.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const natEip = new ec2.CfnEIP(this, "nat-eip", {
            instanceId: natEc2Instance.instanceId
        });
        natEip.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const sharedDefaultRoute = new ec2.CfnRoute(this, "shared-default-route", {
            routeTableId: sharedVpcRouteTable.attrRouteTableId,
            destinationCidrBlock: "0.0.0.0/0",
            instanceId: natEc2Instance.instanceId
        });
        sharedDefaultRoute.applyRemovalPolicy(RemovalPolicy.DESTROY);

        // Use of TransitVpcConstruct would go here. See class for comments on why it is unused.

        // VPC flow logs allow monitoring of VPC traffic data
        // Flow logs can be saved to either cloudwatch or S3
        // Pluralsight course covers both, skipping S3 here because it is near identical to below code
        // and we log using cloudwatch
        const logsIamRole = new iam.Role(this, "LogsIMARole", {
            roleName: "IAM-logs-role",
            assumedBy: new ServicePrincipal("vpc-flow-logs.amazonaws.com")
        });
        logsIamRole.addToPolicy(new PolicyStatement({
            effect: iam.Effect.ALLOW,
            resources: ["*"],
            actions: ["logs:*"]
        }))

        const publicVpcAcceptFlowLogGroup = new logs.LogGroup(this, "public-vpc-accept-log-group", {
            logGroupName: "PublicVPCAcceptLogGroup",
            retention: RetentionDays.ONE_DAY,
            removalPolicy: RemovalPolicy.DESTROY
        });

        // Log all accepted traffic
        publicVpc.addFlowLog("public-vpc-accept-flow-log", {
            destination: FlowLogDestination.toCloudWatchLogs(publicVpcAcceptFlowLogGroup, logsIamRole),
            trafficType: FlowLogTrafficType.ACCEPT
        });

        const publicVpcRejectFlowLogGroup = new logs.LogGroup(this, "public-vpc-reject-log-group", {
            logGroupName: "PublicVPCRejectLogGroup",
            retention: RetentionDays.ONE_DAY,
            removalPolicy: RemovalPolicy.DESTROY
        });

        // Log all rejected traffic
        publicVpc.addFlowLog("public-vpc-reject-flow-log", {
            destination: FlowLogDestination.toCloudWatchLogs(publicVpcRejectFlowLogGroup, logsIamRole),
            trafficType: FlowLogTrafficType.REJECT
        });
    }
}
